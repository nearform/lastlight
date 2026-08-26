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
| **any GitHub envelope whose subject carries the hold label** | `ignore`, or one `reply` naming the label | **First, above every rule below**, including the reply-gate and re-triage short-circuits — "stay off this" has no carve-outs or it is not a hold. One array lookup on labels the envelope already carries, so a held subject never costs a `PrState` resolve. The reply fires only for a `comment.created` that `@`-mentions us (a direct instruction refused rather than ignored); every other event type is silent. See [The hold](#the-hold--the-first-gate) |
| `issue.opened` / `issue.reopened` | `skill: issue-triage` | `reopened=true` for the latter |
| `pr.opened` / `pr.synchronize` / `pr.reopened` | `skill: pr-review` | `ready_for_review` on a draft normalizes to `pr.opened` — it is the moment the PR first asks to be looked at, and the event that un-defers a review `review.skipDraft` held back |
| `pr.checks_settled` | `skill: pr-review` | The head SHA's checks have settled — either colour — on a PR that neither check-outcome route below claimed. This is `review.trigger: after-checks`'s trigger. **Not config-aware:** the router's job is `event → { workflow, context }`, and a deferred review is still *routed* to `pr-review`; the mode is enforced once, at the [dispatch gate](#the-pr-scoped-dispatch-gate) |
| `pr.labeled` | `skill: pr-review`, or `ignore` | Routed **only** when the added label equals the operator's `review.requestLabel` **or the target repo's** (the real `on-request` mechanism — a GitHub App bot user cannot be picked in the reviewer dropdown). The repo's value is reached through the same injected `resolveRepoPolicy` seam the dispatch gate uses, so it is one cached config resolution per label event; without it the key was inert for repos, since the shipped operator default is `null` and the event was dropped before any repo layer resolved. Every other label is a hard router-level ignore, so routine labelling never costs a `PrState` resolve |
| `pr.review_requested` | `skill: pr-review`, or `ignore` | Routed only when the request names **us** — either through GitHub's reviewer picker (opportunistic: App bot users are not generally selectable there, so `on-request` must not *depend* on it) or through the Re-run button on our own `last-light/review` check, which the connector normalizes to this type. An explicit request, so it overrides mode, draft and dedup |
| `pr.checks_failed` | `dependabot-ci-fix` (dependency PR) / `pr-fix` (anything else) | A failing `check_suite`. Routed **deterministically** off `envelope.isDependencyPr` — the discriminator the connector already computed to decide whether to emit at all (see [Integrations](/spec/03-integrations)) — with no classifier call, exactly like the green path below. It used to go through the classifier, which could only ever land on `dependabot-ci-fix`: `fallbackWorkflowForIntent` resolves a workflow by its `classification.intent` and `pr-fix.yaml` has no `classification:` block, so `pr-fix` was structurally unselectable. That was harmless only while the connector's gate was dependency-only; now that a PR whose head **we** pushed also emits the event, a human's red PR would have run a dependency-bump prompt, the `dependency-*` label vocabulary and a `requires-human` preflight it was never designed for |
| `pr.checks_passed` | the workflow claiming the `dependabot-pr-merge` intent (else `ignore`) | A green `check_suite` on a dependency-update PR (the connector already pre-filtered to Dependabot / Renovate). Routed **deterministically** via `getWorkflowByIntent("dependabot-pr-merge")` — no classifier call, since the dependency-PR gate is the connector's job |
| `comment.created` with pending reply gate | `skill: explore-reply` | Reply-gate short-circuit — see below |
| `comment.created` on a pre-build issue, plain (no `@last-light`) | `skill: issue-triage` (`mode: retriage`) | Reporter-driven re-triage — see below |
| `comment.created` without `@last-light` | `ignore` | reason: "no bot mention" |
| `comment.created` from non-maintainer | `reply: "only maintainers can trigger builds"` | `authorAssociation` not in `MAINTAINER_ROLES` |
| `comment.created` matching `@last-light approve\|reject [reason]` | `skill: approval-response` | Regex parse, no classifier |
| `comment.created` matching `@last-light retry [reason]` on a **PR** | `dependabot-ci-fix` (dependency PR) / `pr-fix` (anything else) | The recorded "go again" — regex parse, above classification, because a retry has to be an exact instruction rather than an LLM guess. Free text after the command becomes the intervention's `note`. Carries `_retry` down to the dispatch gate, which hands it to `resolvePrState`; see [Un-sticking an escalated PR](#un-sticking-an-escalated-pr--the-three-retry-surfaces). On an issue it means nothing and falls through to the classifier |
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
classifier path, and "record a demo of this" reaches `demo`. All three have a
Slack branch too — `demo` acquired one late: it shipped with a classification
block and a `routes.slack.demo` entry but no `case` in the `message` switch, and
because `demo` is in `WELL_KNOWN_INTENTS` the intent fallback skipped it as
well, so every demo-classified Slack message fell through to plain chat against
a configured route.)

### TRIAGE on Slack needs an issue

`issue-triage` triages **one** issue. Repo-wide triage is a real capability but
it rides on `context.mode = "scan"`, and exactly two things set it: the
webhooks-off `triage-new-issues` cron, and `lastlight triage <owner/repo>` with
no `#N`. **The Slack branch sets neither `mode` nor `issueNumber`**, so it used
to hand a single-issue workflow an empty target — and its clarify text
(`triage cliftonc/repo`) advertised the repo-wide form it could not deliver.

What that produced, in one real run: a Slack message classified `TRIAGE`,
dispatched with `issueNumber: 0` and an empty `commentBody`, whereupon the agent
improvised a `list_issues` sweep, inspected one issue, changed nothing, emitted
`TRIAGE_COMPLETE` and recorded **succeeded** after 110 s of sandbox. The
`requires_marker` postcondition cannot catch this: it proves the agent did not
bail, not that it was asked anything.

Two fixes, and the second is the load-bearing one:

- The branch now **requires an issue** and replies asking for one otherwise —
  after the managed-repo gate, so a missing issue can never mask an unmanaged
  target.
- It forwards **`commentBody: slackText`**, as `demo` and `question` already
  did. Without it the request never reaches the agent at all: in the run above
  the word "overdue" appears nowhere in the 775-line transcript.

**The classification block is what stops the misroute happening at all.** It was
one line, defined the intent purely by *subject matter* ("scan/triage issues on a
repo"), and carried no deliverable and no counter-examples — while every peer
block states what comes out ("the deliverable is an ANSWER", "make code changes
NOW", "a short screen-recorded mp4"). So any sentence pairing "issues" with a
repo matched it, and *"are there any issues in cliftonc/drizzle-cube that are
overdue?"* — a question, whose deliverable is an answer — matched it best of all.
It now states its deliverable (labels), requires one issue, and makes the CHAT
downgrade explicit, with the real misroute as a counter-example. `QUESTION`
already carried the same downgrade; TRIAGE simply never yielded to it, and chat
reads issues and their comments from GitHub directly. Pinned by
`tests/workflows/issue-triage.test.ts`, which asserts the *shape* — a deliverable,
the downgrade, counter-examples resolving to CHAT — rather than the wording.

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

**One surface-specific exception**, `GITHUB_ONLY_INTENTS` in `classifier.ts`:
`dependabot-ci-fix` and `dependabot-pr-merge` are deliberately *outside*
`WELL_KNOWN_INTENTS` because the GitHub comment ladder reaches them **through**
this fallback (route key `intent.<name>`). Both are `pr_scoped` and reach their
real dispatch path, `handlePrFix`, via `context.prNumber` — which the GitHub
route supplies from the event and no Slack branch ever sets. So on a Slack
message the same fallback dispatched them straight past the PR-fix path with no
PR at all. The `message` case therefore excludes that set explicitly and lets
them fall through to chat, which can point the user at the PR. The exclusion is
per-surface rather than a `WELL_KNOWN_INTENTS` entry precisely because
"does the router branch on this?" has different answers on the two routes —
answering it globally breaks GitHub to fix Slack.

**New issues** (`issue.opened`) route through the same composed classifier:
`classifyIssueIntent()` runs the main classifier over the issue title + body and
sends a `QUESTION` intent to the `answer` workflow, everything else to triage
(the safe default). This replaced a separate hardcoded question-vs-work prompt —
`answer.yaml` now owns the `QUESTION` category, so the two share one vocabulary.

**`QUESTION` vs `CHAT` is a CAPABILITY test, not a seriousness one.** `answer`
provisions a sandbox; chat answers in-process in seconds — and chat is not
toolless, it reads repos, issues and their comments, pull requests **and their
diffs**, file contents, commit history, and both code and issue search
(`src/engine/github/github-tools.ts`). So `answer.yaml`'s category admits only
the two things chat genuinely cannot do: **the web** (`web_search: true` — a
comparison against another tool, upstream docs, current external facts) and
**real exploration of a checkout** (tracing a behaviour across many files,
following call paths). A question answerable from chat's own reads classifies
`CHAT` however technical it is, and naming a repo is explicitly *not* evidence
of weight — the counter-examples in `answer.yaml` teach exactly that, because
without them the model reads `REPO: <x>` as the signal to fire.

The one carve-out is the surface: the downgrade applies to **chat/Slack messages
only**, where a chat path exists to catch it. A newly-opened GitHub **issue**
that asks a question is always `QUESTION` — an issue has no chat surface, so
`CHAT` there means the question is silently triaged as a work item instead of
answered.

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
(`src/engine/pr-state.ts`), computed once per dispatch for any workflow declaring `pr_scoped: true` in its
YAML (`prScopedWorkflows()`, `src/workflows/pr-scope.ts`; the packaged four are
`pr-fix`, `dependabot-ci-fix`, `dependabot-pr-merge` and `pr-review`). It has
two halves — live GitHub facts (head SHA and its git
author, head/base refs, draft, fork, labels, checks state + settled count,
base-branch checks, our own review at the head, the CI failure report) and
facts derived from our run history keyed on the PR (attempt number, flaky
deferrals, the SHA one of our runs escalated at, the SHA at which a fork PR was
told we cannot help, prior-attempt markers, cost spent on the current problem,
the last assessed head SHA per workflow, and any PR-scoped run currently in
flight). Resolution never throws: every read is independently best-effort and
degrades to a value that *cannot* cause a skip, with the failures listed on
`readErrors`. It rides down to `dispatchWorkflow` on the context, so nothing is
fetched twice.

`readErrors` is **read** by exactly one guard, and only for one entry.
`getPullRequest` is the read that supplies `labels`, `isFork`, `isDraft` and
`headSha`, and each of its degraded values is the permissive one — `labels: []`
so the hold below does not apply, `isFork: false` so the fork guard does not,
`headSha: ""` so the dedup does not. A 403 therefore yields a snapshot
that *looks* healthy, and the cron route would dispatch a repo-write sandbox run
against a pull request we know nothing about. So a failed PR read produces a
`read-degraded` skip in all three dispositions, ahead of every other guard
including the hold and the run lock. It is transient like a lock drop — no
label, no comment, no run row — and the cron re-pickup is what makes dropping
sound. Every other read still fails open exactly as described.

### The hold — the first gate

One label, applied by a **human only**, stops Last Light acting on a subject
entirely. It is checked in `resolveDispatchDisposition` above every other
guard except the degraded read: above the run lock, above the fork check,
above the budgets, and above an explicit `@bot` request. The packaged name is
`lastlight-ignore`; it is operator-configurable as `hold.label`
(env `LASTLIGHT_HOLD_LABEL`, see [Configuration](/spec/02-configuration)), lives
in `src/cron/dependabot-discovery.ts` beside the rest of the label vocabulary,
and is created with its own colour by the same `github_ensure_labels` pass the
dependency prompts run.

Why a **label** rather than a stored record, a comment convention or a config
list: it is a *live precondition*, which is the same property that makes
`baseChecksState` safe to gate on. It re-evaluates on every event, it is
idempotent (present or absent, so there is no ordering to resolve between two
maintainers), it is maintainer-gated for free because GitHub already requires
triage permission to change a label, and **removing it resumes the bot with no
record to clean up**. Nothing is persisted and nothing has to be migrated.

The skip is **silent** — no `requires-human`, no comment, no run row, and for
`pr-review` no placeholder check either. It is not a verdict about the change;
it is an instruction we are obeying, and the label on the PR already says
everything a comment could. Labelling and commenting on a pull request somebody
has explicitly asked us to leave alone would be the exact opposite of what they
asked for, which is why the hold sits *above* the three escalating skips rather
than beside them.

The hold **beats an explicit request** — otherwise it is not a block. The one
thing a direct `@bot …` earns is **one reply naming the label and how to lift
it**, because silently ignoring a direct instruction is worse than refusing it.
That reply belongs to the route that has a human on the other end (the router's
comment path, or the dispatcher's PR gate), never to the decision — the same
rule the fork notice and the run-lock reply follow, and the reason a cron tick
on a held PR says nothing at all. No de-duplication is needed: it fires only on
an explicit ask, so it is one reply per ask.

The gate above governs the four PR-scoped workflows. The hold blocks **every**
workflow on **any** subject, PRs and issues alike (one word, one meaning), so
the router applies the same check to the envelope's labels as a hard ignore
before any branch — which is what makes `issue-triage`, `issue-comment`,
`build`, `explore`, `verify` and everything else honour it, and what keeps a
held subject from costing a `PrState` resolution per event.

`requires-human` is the **other** label, and it does the other job: it is
written by us (by `escalatePr`, and by the agent per the dependabot prompts) and
**read by nothing**. It means "I stopped and a human should look" — a
notification. It used to be read as a decision input, with the code inferring
*whose* label it was from "have we ever run on this PR"; that inference was
honoured only on a PR the bot had never touched, so on any PR it had ever
reviewed or assessed a maintainer's hand-applied `requires-human` read as the
bot's own escalation and was cleared by the next person's push. The hold label
replaces that inference with an instruction.

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
  PR's age. It is also what **model escalation** keys on
  (`fix.escalateModelAfterAttempt`): `attempt` is a budget position that
  re-arms, this is the count that survives, and keying the model on the
  counter downgraded a PR that had already failed three times to the base
  model the moment somebody asked for another go.
- **`priorDiagnosisClass`** is the *immediately preceding* run's class,
  and the only prior-run verdict any dispatch decision reads (see the
  escalation section below for why that is allowed). Unlike
  `flakyDeferrals` it is **not** carried across a run that diagnosed
  nothing — including our own escalation row — so a remembered
  `infra-dependent` cannot re-escalate on the next event and put the label
  straight back.
- **`intervention`** is the RETRY direction of human intent, and the
  counterpart to `escalatedAtSha`: *the last time a human told us to try
  again*, with the head SHA they asked at, how the ask arrived, who made
  it and why. It is the one thing that makes an escalated problem
  dispatchable **without a new commit**. Before it, "a human intervened"
  could only be inferred from a commit — the head SHA changed and we did
  not author it — so of the three things a maintainer would naturally
  try, exactly one worked. `by` and `note` are recorded for **display and
  for the journal only**: no decision function reads either, which is the
  same rule `notes` lives under. Capability is checked at each surface
  (`author_association`, GitHub's own label permissions, the admin
  session); identity is never a decision input, and there is no precedence
  between two maintainers — last one wins.

A fresh problem clears all four together: a prompt that says "attempt
1" while recounting three earlier attempts is incoherent.

**There are two ways to become a fresh problem, and they are not the same
fresh problem.** Someone else's push wipes `priorAttempts`; a recorded
retry **carries** it and appends one bounded seam line
(`— retried by request: "…" —`). A push changed the code, so prior findings
may be stale; a retry changed nothing but patience, and discarding the
journal there sends attempt 1 of the new window straight down attempt 1 of
the old window's road. Both reset `attempt`, the cost baseline,
`flakyDeferrals` and `priorDiagnosisClass` — a human intervening is a
statement that the flaky-versus-real inference should start over, and they
have better evidence than the counter does. The journal's *staleness*
marking follows the head, not the boundary: a note about a commit that is
still the head is not stale.

A retry also **un-assesses the head** for the fix family, because the
escalation row — and the attempt that exhausted the budget before it — both
record `succeeded` at that SHA, so the `already-assessed` dedup below would
otherwise swallow every retry that did not arrive as an explicit `@bot`
request. It stays un-assessed **until a run has served the ask**, not just
for the tick the ask arrived on: the row claiming the head has to carry the
same intervention on its own snapshot before the dedup binds again. A retry
that is recorded on one tick and dispatched on a later one — which is what
the standalone `retry-requested` row exists for — would otherwise be
un-assessed on the tick that could not use it and re-assessed on the tick
that could. That row is itself kept out of `assessedHeadShaByWorkflow`: it
records a dispatch that did **not** happen, so it is not evidence that
anything was assessed, and it carries the intervention forward, so counting
it would make it read as having served the ask it was written to defer.

- **`notes`** is the PR's **journal** — a bounded, agent-written memory
  (`src/engine/pr-notes.ts`). The four other fields above are things the
  harness derives; this is the one thing the *agent* can choose to
  remember. It rides the same harvest hook: the agent appends
  `<kind>: <one line>` to `.git/lastlight-notes` in the checkout, and
  `onPhaseEnd` drains the file onto `scratch.fixMarkers.notes`. Unlike
  the four, it is keyed across every PR-scoped workflow rather than the
  fix family alone, so `pr-review` reads what `dependabot-ci-fix`
  learned. Bounds: 20 notes per PR (oldest evicted), 240 characters
  each, 4 KiB rendered (newest kept). Four kinds — `finding`,
  `constraint`, `ruled-out`, `todo` — of which only `ruled-out` records
  a verified negative and reads as durable. A fresh problem **marks**
  every note stale rather than clearing it: a claim about the old head
  is not evidence about the new one, but deleting it silently would be
  indistinguishable from never having written it.

  Two rules make the journal safe to replay into a later, privileged
  prompt. **It cannot forge anything**: notes are flattened to one line
  on ingest (so a note can never emit a line of its own, and therefore
  can never forge the fence it renders inside), and any note containing
  `class=` or a marker tag is rejected outright — those tokens are
  parsed, and a note able to write one could change what the workflow
  does. **It cannot authorise anything**: no decision function reads
  `notes`. `renderContext` projects it to a single fenced string,
  `{{priorNotes}}`, and that is its only consumer — there is no boolean
  or per-kind list a `skip_if` expression or a gate could branch on. A
  note may tell an agent something; it can never make a code path
  reachable, stand in for the local push gate, or cause a push.

- **`closes` and `changedFiles`** are the two fields that are *not* resolved
  with the rest of the snapshot, and the exception is deliberate. They feed
  the `spec` axis of the review evidence pipeline — the issues a PR says it
  closes (with their bodies: what was **asked**) and the paths it changes
  (**where** an ask could have landed) — and nothing else reads them. They
  cost two live GitHub reads that no pre-existing decision needs, so
  `resolveSpecContext` fills them as a separate step at the dispatch choke
  point, gated on `review.analysis.enabled` (operator-only, off by default)
  and on the workflow being `pr-review`.
  With the axis off nothing is fetched, so the projection has nothing to
  project and the reviewer's context is byte-for-byte what it has always
  been. `changedFiles` is `null` — never `[]` — when it was not read or the
  read failed, because a PR that changes nothing and a PR we could not ask
  about are different facts, and the obligation builder refuses to emit
  anything at all on `null`: an obligation naming only the ask would be a
  one-ended seed, which measures *worse* than no seed. Both reads are
  best-effort like every other read here, and a failure lands in
  `readErrors`.

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

  The lock is enforced **inside the decision functions** (`runLockDrop`,
  called first by `resolveFixDisposition`, `resolveMergeDisposition` and
  `resolveReviewTrigger`), not by the route. It began as an inline check in
  the dispatcher, which meant the webhook route obeyed it and the cron
  fan-out and `/api/run` did not — so the daily `fix-red-dependency-prs`
  could dispatch onto a PR with a live `pr-fix` run, which is the very
  sequence the lock exists to prevent, made worse by the fix family now
  sharing one workspace per PR. The PR-scoped set is exactly the union
  of the three dispositions, so placing it there covers every route by
  construction, including a caller that reaches a disposition directly.
  It is checked **before every other skip**: ordering it after the
  escalating skips would label a PR `requires-human` for a budget a live run
  is still spending, and ordering it after `explicitRequest` would let an
  `@bot fix this` walk into the running agent's workspace. A lock drop
  carries no escalation case — it labels nothing, comments nothing and
  writes no run row — and the route that has a human on the other end
  replies to them.
- **No prior run's verdict may gate dispatch — unless the skipping path
  writes a run row.** A skip returns `{ kind: "skipped" }` and writes *no*
  row, so a gate on "what did the last run conclude" reads the same stale
  row forever and the PR is dead with no label, no comment and nothing on
  the PR explaining why. Almost every gate here is therefore a **live
  precondition** (`baseChecksState === "failing"` is `upstream-broken`, not
  a remembered diagnosis) or a fact about the PR that a human action can
  change. The single exception is `priorDiagnosisClass`, and it is allowed
  exactly because its skip *escalates* — which records a row (below).
  The escalation guard follows the same rule: the *state* is "we escalated
  at head SHA X" (`escalatedAtSha` on the run context) and nothing else, so
  a maintainer's push re-arms the loop automatically with no label to
  remove by hand. The `requires-human` label itself is read nowhere; a human
  who wants the bot off a PR applies the hold instead.

**The escalation guard is not identical on the fix and merge routes**, and
the difference is the whole point. `resolveFixDisposition` treats a head we
authored as *still the same problem*
(`headSha === escalatedAtSha || headIsOurs`): our own retry push must not
re-arm the attempt counter, or the loop never terminates.
`resolveMergeDisposition` compares `headSha === escalatedAtSha` **only**.
On that route our commit at the head is not another attempt — it is the
RESOLUTION, and the entire `dependabot-ci-fix` → `pr.checks_passed` →
`dependabot-pr-merge` handoff ends with it. Carrying the disjunct across
made the handoff structurally unreachable for any PR we had ever
escalated: ci-fix repaired the branch, CI went green, and the merge route
skipped *because we were the one who fixed it* — 27 of 37 green dependency
PRs sat behind it. Dropping it does not unbound the route: a merge run that
declines re-stamps `escalatedAtSha` at the head it just assessed (so the
comparison catches the next dispatch), and one that succeeds populates
`assessedHeadShaByWorkflow`, so the per-head `already-assessed` dedup below
bounds it to **one assessment per head SHA** — the bound every
never-escalated PR already lives under.

An explicit human request (`comment.created` / `pr.review_requested` /
Slack `message` / `/api/run`) overrides the
escalation guard, the not-retryable verdict and the per-SHA dedup — a
maintainer asking directly is an intentional override — but not the facts:
a fork PR, a red base branch and an exhausted budget do not care how nicely
you ask. Fork PRs are the one skip the author is owed an explanation for,
so the gate posts a comment saying we have no branch to push to.

### Un-sticking an escalated PR — the three retry surfaces

Clearing the *guard* is not the same as moving the *window*, and confusing
the two is how `budget-exhausted` came to re-comment on every push (#256).
An explicit request has always cleared the guard, then fallen straight
through into a budget gate with no override — so asking bought a duplicate
escalation comment and nothing else. A recorded **`intervention`** moves the
window instead, which is what makes all three of these do the same thing:

| Surface | How it is authorised | Notes |
|---|---|---|
| `@<bot> retry [reason]` on the PR | the `author_association` check that gates the whole `@`-mention path | Structured, above classification. Free text after the command becomes the `note` — it reaches the next attempt as the journal's seam line and as a `PrNote`, both bounded and fenced by `pr-notes.ts`, and is rejected outright if it carries `class=` or a marker tag |
| Removing `requires-human` | GitHub already requires triage permission to change a label | **No webhook.** "We escalated at this head, the head has not moved, and our label is gone" can only be a human having removed it — detectable only because the label is now a pure notification, so its absence carries no competing meaning |
| `POST /admin/api/prs/:owner/:repo/:number/retry` — `lastlight pr retry <owner/repo#N> [reason]`, and the dashboard when it comes | the authenticated admin session (`authMiddleware`), plus the `isManagedRepo` allowlist every repo-touching admin path honours | `via: "api"`, `by` from the session, optional body `{ reason }` → `note`. The only surface with **no event of its own**, so it is the only one that dispatches — see below |

A retry **consumes the escalation**: `escalatedAtSha` is cleared, which is
how the re-arm becomes visible to decision functions that see only the
snapshot. That is also what bounds the whole mechanism — the next
escalation writes a fresh `escalatedAtSha` at the same head, the
intervention is by then the one the prior run already saw, and the
`escalated:` skip binds again. Retries are otherwise **unbounded, full
window each time**: the backstop is a server-level spend cap, not a hidden
second budget.

**What a retry does not override:** the hold label (which beats it
outright, and earns the asker one reply naming the label), the fork guard,
the run lock, `upstream-broken`, or a degraded read. Those are facts about
the pull request or instructions that outrank it; the budgets are policy,
and policy is what a maintainer may move.

**Where the record lives.** Normally on the dispatched run's own snapshot —
`dispatchWorkflow` persists the whole `PrState` on `context.prState`, so a
retry that results in a run needs no row of its own. When the gate then
skips for an unrelated reason (`upstream-broken` is the case that matters:
the base is red at the exact moment somebody asks), `recordIntervention`
writes a standalone row in the same shape and the same order as
`escalatePr` — the record first, before any GitHub write. Two mechanisms
with the same shape and different orderings is how the next reader gets it
wrong. Nothing is recorded when the hold beat the retry, when the PR read
was degraded, or when another run owns the PR (a row written under a live
run would displace that run's own snapshot as the history the next dispatch
folds from; the route's "ask me again" reply is the right answer there).

**Why the admin route dispatches.** The other two surfaces arrive *on* an
event that is already dispatching; the API surface has no event behind it, and
an escalated PR is by definition one no further `check_suite` will fire for.
Recording and parking would leave the ask waiting on the daily sweep at best,
and on nothing at all for a PR no cron covers — so `lastlight pr retry` would
report success and change nothing anyone could see. The record itself does
survive being parked (the un-assess above holds until a run serves the ask),
which is what makes the standalone row worth writing; dispatching is about the
*asker* getting an answer, not about the record surviving.

Which is why the route crosses `applyPrDispatchGate` **itself** rather than
leaving it to `dispatchWorkflow`. The armed snapshot has to travel down on
`_prState` (it carries the intervention), and an inherited snapshot is exactly
the signal `dispatchWorkflow` reads as *"this route already decided"* — the same
contract the dispatcher works under. The rule is: **the route that resolves is
the route that gates.** So the retry endpoint is a third caller of the one gate,
not a third copy of it, and the guard list above ("what a retry does not
override") applies to it unchanged. Its three answers map onto the gate's own
verdicts:

| gate | HTTP | body |
|---|---|---|
| `run` | 200 | `dispatched: true`, `recorded: false` — the record lives on the dispatched run's snapshot |
| `skip`, not one of the three below | 200 | `dispatched: false`, `recorded: true` — the standalone row is written (inside the gate), so the next event honours it |
| `skip` with `onHold` / `runInFlight` / `readDegraded` | 409 | `dispatched: false`, `recorded: false`. The hold's `reason` is `holdReply()` — the same sentence the comment route gives, because the person asked and was refused |

`config.github` / `config.dispatchWorkflow` / `config.resolveRepoPolicy` are the
three collaborators `src/index.ts` wires for it — the last one being the *same*
`resolveRepoRunConfig` closure the dispatcher gets, so the admin route cannot
read a repo's clamped budgets looser than the repo set them. Absent (chat-only,
CLI-only) the endpoint reports 503 rather than acting on a snapshot made of
defaults.

### `review.trigger` — one resolver, every route

`resolveReviewTrigger` is the gate for `pr-review`, and it is the only
implementation of `review.trigger` anywhere. That is the whole point: the
trigger surface used to be spread across four places — the connector's
`normalize()`, the router's hardcoded `pr.* → pr-review`, the cron's
`condition.unless: webhooksEnabled`, and the dispatcher's check-posting
block — of which exactly one was config-aware. Keeping the crons would
otherwise have required *three* independent implementations, in a change
whose thesis is "make the policy configurable rather than hardcoded".

The split is **discovery vs. policy**, not cron vs. webhook.
`src/cron/review-discovery.ts` is now a pure candidate finder — open PRs in
managed repos that **no bot** authored — and knows nothing about modes,
drafts or settled checks. Its old draft filter and its per-candidate
`getLatestBotReview` call are `PrState` fields (`isDraft`,
`botReviewAtHead`), resolved once, checked once, for every route.

The bot-authorship filter is the one thing discovery does decide, and it is
arithmetic rather than policy: GitHub 422s an attempt to review your own pull
request. It uses the **webhook route's predicate verbatim** — any author ending
`[bot]`, plus the configured `botLogin` — because the two routes answering this
differently is a spend loop, not a cosmetic drift. Discovery used to compare
against `botLogin` alone, so a PR opened by a *different* App installed on the
same repo was dropped by the webhook and accepted by the sweep. On the `nearform`
instance (running as `nearform-lastlight[bot]`, on repos carrying
`last-light[bot]` PRs) that matched nothing: seven PRs were re-dispatched every
30 minutes for days, each one running the review agent to completion before it
refused to self-review — 1260 review executions, 0 reviews posted, ~$1.30/hour.

The resolver returns three values, because "do not run" and "what should
the check say" are different questions:

| Decision | When | `last-light/review` (only when `review.postsCheck`) |
|---|---|---|
| `dispatch` | an explicit request, the `review.requestLabel`, `eager` on PR attention, or a settled suite under `after-checks` | `in_progress`, completed from the run's terminal transition |
| `defer` | `on-request` with nobody asking; `after-checks` waiting for CI (on every route but the sweep — see below), or reached on PR attention rather than a settle | `queued` under `after-checks`, `neutral` under `on-request` — and only on a PR-attention event, since a placeholder is a statement about a head SHA and the 30-minute sweep would otherwise re-post one per tick |
| `skip` | draft (`review.skipDraft`), already reviewed at this head, a `pr-review` run that already assessed this head without posting, only generated files changed since the review we posted (`review.generatedPaths`), or another PR-scoped run in flight | **nothing** — except the generated-only case, which posts a completed `carried-over` check restating the prior verdict. A run that never dispatches must otherwise not create a check and immediately conclude it |

Two consequences worth stating outright:

- **An explicit `@bot review` always dispatches**, overriding mode, draft
  *and* dedup. Today that carve-out is accidental — the comment path simply
  never crossed these code paths — and as one branch of the resolver it
  becomes a decision. The **one** thing it does not override is the run
  lock, which is checked above it: the lock is not policy but a physical
  constraint (one workspace, one branch, one agent). The requester is told
  so, and the sweep is the re-pickup.
- **The sweep is exempt from the `pending` deferral.** `defer` on
  `checks-pending` applies on every route *except* `route === "sweep"`. A
  check run that never CONCLUDES — a fork PR's `workflow_run` awaiting
  maintainer approval, a dead self-hosted runner, a third-party app that
  opened a check and crashed — leaves the aggregate `pending` with no
  further `check_suite` ever coming, so deferring on every route deferred
  forever, and with `review.postsCheck` on the `queued` placeholder sat
  there permanently. Nothing in the snapshot dates the pending state, so the
  sweep cannot tell "CI is still running" from "this will never settle" and
  must pick which error to make: a review posted 30 minutes into a running
  suite costs timing (it cannot cite a failure that has not happened, and
  the next push re-arms `botReviewAtHead`), while a PR that is never
  reviewed and possibly never mergeable costs correctness. `after-checks`
  is "on settle, either colour" — the colour was never the gate, and on the
  one route that exists to pick up what no webhook will fire for, neither is
  settling.
- **A push with nothing new to say does not earn a review** (issue #271).
  Per-head dedup was the only suppression gate, so every new head SHA bought a
  full formal review *by design* — and a lock file re-derivation is a new head
  SHA. `nearform/skillspro#1641` got two byte-identical APPROVEs six minutes
  apart. So when every path changed since the review we **posted** matches
  `review.generatedPaths`, the resolver skips. Three properties make that safe:
  it sits *below* the explicit-request branch, so `@bot review`, the request
  label and the check's Re-run button all still force one; the baseline is the
  review we posted (`PrState.lastBotReview`) rather than the last head we ran
  at, so a run whose `post-review` declined to post cannot suppress the change
  it never reviewed; and the delta (`PrState.pathsSinceLastBotReview`) is `null`
  on every degraded or truncated read, which dispatches. It is `skip` and not
  `defer` because no future event turns *this* delta into a review. The check
  run is the one place this skip is not silent — see `carried-over` below.
- **A run that posted nothing still counts as having looked.** `botReviewAtHead`
  is evidence of a POSTED review, so for a long time it was the only per-head
  dedup the review path had — and any run that completed without posting left no
  trace of itself at all. The sweep exists precisely to re-pick-up PRs no webhook
  will fire for again, so it re-dispatched the same head forever. So the resolver
  also skips when `PrState.assessedHeadShaByWorkflow["pr-review"]` equals the
  head SHA: a run happened here and had its say. The two fields stay distinct
  rather than merging, and the distinction is the point — `lastBotReview` is the
  generated-only gate's *baseline* and must be a review somebody could read,
  while this one answers the different question "did we already spend a run on
  this SHA". Only **succeeded** runs populate it (`applyDerivedState`), so a run
  that crashed is retried; it sits below the explicit-request branch, so `@bot
  review` and the Re-run button still force one; and it is keyed per workflow, so
  a `pr-fix` run at the same head does not suppress the review that fix was meant
  to earn. A push clears it, because the SHA moves.
- **Fix outranks review** on a settled-failing suite, and it needs no new
  state. `normalize()` returns one envelope per delivery and `route()`
  returns one handler, so a `check_suite.completed` fan-out into both
  `pr.checks_failed` and a review trigger is not expressible; the connector
  emits `pr.checks_settled` only for what the fix and merge routes did not
  claim. The gap that leaves is the fix chain that ends **without pushing**
  — attempts exhausted, `infra-dependent`, a `flaky` deferral,
  `upstream-broken`, or a crash — where no new commit exists and no further
  `check_suite` will ever fire. `check-prs-awaiting-review` is the release
  mechanism for all five, which is the strongest single reason it still runs
  with webhooks enabled.

### The `last-light/review` check is a projection of run state

The check used to be created in the dispatcher's webhook branch and
completed inside a `.then()` chained onto the in-memory workflow promise,
with `updateCheckRun` appearing nowhere else. Two defects followed. A
cron-, comment-, Slack- or CLI-triggered review got **no check at all**.
And the one that did got stranded `in_progress` on every server restart
mid-review (i.e. every deploy), every queued-then-resumed run, every
`expireStaleRuns` cancellation and every crash — invisible only because
`check-prs-awaiting-review` re-reviewed within 30 minutes and posted a
*superseding* check under the same name. That accidental repair is
incompatible with the per-SHA review dedup: a check strands most often on a
review that ran and posted, which is precisely the state the dedup skips.

The fix is durability, not routing (`src/engine/review-check.ts`):

1. The check is created at the **`dispatchWorkflow` choke point every route
   crosses**, immediately after some gate said "run", so the check and the
   run are created together or not at all.
2. Its id — plus owner, repo and head SHA — is persisted on the run row
   (`scratch.reviewCheck`) the moment the row exists.
3. It is completed from the run's **terminal transition**, via a
   `TerminalRunObserver` on the run store — the same place that writes
   `succeeded` / `failed` / `cancelled`. `simple.ts`, `resume.ts`,
   `expireQueued` and the admin cancel therefore all resolve it for free,
   and a ninth terminal path cannot be added without one.

The conclusion is read from the review we actually **posted** at that head
SHA, not from the run's exit code: a `succeeded` run that legitimately
skipped must not claim an approval it never gave. `neutral` is the honest
answer whenever there is no verdict, and branch protection treats it as
passing, so a review that failed to run never blocks a merge on its own.
Boot-time reconciliation is deliberately not needed — terminal-transition
completion plus the existing `MAX_RESTART_RESUMES` resume path covers
restart.

**`carried-over` — the one skip that still leaves a check.** Every other
review skip either already has a check on this head (`already-reviewed`) or
must not have one (draft, hold, run lock). The generated-only skip above is
different: it leaves a brand-new head SHA with no `last-light/review` at all,
and on a deployment whose branch protection requires that check, a missing
check is an unmergeable PR. So it posts a **completed** check restating the
review that still stands, naming the SHA it was posted against and how to force
a fresh one. Its conclusion **mirrors that prior review** — `APPROVED` →
`success`, `CHANGES_REQUESTED` → `failure`, anything else → `neutral` — because
carrying a `CHANGES_REQUESTED` forward as `success` would clear a merge gate the
review deliberately closed. It is also the one placeholder exempt from the
PR-attention route limit: under the packaged `after-checks` trigger the decision
is taken on the `checks-settled` route, so limiting it to attention would leave
the check missing on exactly the heads it exists to cover. Re-posting is
harmless — GitHub shows the latest run of a check name on a SHA.

**The self-gating deadlock.** `getChecksConclusion` aggregates every check
run on the head SHA, ours included, so a `last-light/review` sitting
`queued` (waiting for CI under `after-checks`) or `in_progress` pins the
aggregate at `pending` — the settle event never fires, the review never
runs, and a repo that made the check *required* has an unmergeable PR
forever. The identical loop reaches `pr.checks_passed` on a Dependabot PR.
So the three settle queries take `{ excludeApp }` and every **trigger-side**
caller passes `botName`: the PR snapshot, the webhook connector's settle
gate, the router's dependency-comment enrichment, and both dependency
sweeps. Commit statuses carry no app and we never post one, so nothing is
excluded on that side, and excluding ours can never turn red into green.

The same aggregate has a second way to jam: a check re-run in a fresh suite
comes back *alongside* the attempt it replaced, so a job re-run green kept
reporting red forever. Every settle query collapses the list to the latest run
of each `(app, name)` first — see
[Integrations → Superseded check re-runs](/spec/03-integrations).

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
`on-hold` is a maintainer's instruction to stay off the PR, `escalated` is
already escalated, and `already-assessed` is a duplicate delivery.

The **run row is the load-bearing part**, not bookkeeping.
`escalatedAtSha` is read back off the *prior run's* persisted
`context.prState`; a dispatch-time skip writes no row, so an escalation
that stayed row-less would never persist it — the guard would never bind,
and every subsequent event on the same dead PR would escalate again,
re-applying the label and posting the comment once per event. The row is
recorded `succeeded` (`failed` is reserved for malfunction) with the
resolved snapshot on it, so the run detail panel explains the stop.

Three consequences follow from that ordering:

- **The row is written before the label.** The row is what binds, so a
  label write that fails costs the PR its *notification*, not its guard:
  the escalation record is already down and the next event takes the
  `escalated:` skip. Label-then-crash would leave a `requires-human`
  nothing in the code can see, so every later event would escalate and
  comment again.
- **The comment is posted only behind a label that landed**, so a failed
  label write leaves no orphaned explanation on the PR.
- **Once-only is a property of the record, not of an API scan.** Neither
  `postComment` nor `addLabels` de-duplicates; the next dispatch at the
  same head reads `escalatedAtSha` back and takes the `escalated:` skip,
  which carries no escalation case and therefore applies nothing. That
  makes it entirely dependent on the `escalated:` guard firing first — and
  the guard is bypassable, by an explicit request, by a hand-removed label
  or by a retry, every one of which lands back in `escalatePr`. So it also
  **refuses outright when it has already escalated at this exact head**.
  Re-recording would be harmless; re-commenting is #256.

The comment's closing section is a **contract**: it is the only place most
people will ever learn how to un-stick the bot, so every exit it names has
to work and every exit that works has to be named. It used to fail both
halves — it promised *"you can also ask me directly in a comment to
override"*, which the budget gate refused, and it predated the hold label
entirely. It now lists the three retry surfaces (push, `@<bot> retry
[reason]`, remove `requires-human`) as one group, because they do the same
thing, plus the hold as the opposite of a retry. It is pure and
table-tested, and it renders the deployment's own configured `hold.label`
and `@<botName>` rather than the packaged names.

The **fork-PR notice** (`noticeForkPr`, same module) is the one non-escalating
skip that still speaks on the PR: nothing is wrong with the author's change, we
simply have no branch to push to. It follows the same two rules — a run row
first, carrying `forkNoticedAtSha`, then one comment — so it is said **once per
PR**, and the caller keys on the typed `fork-pr` decision rather than on
`state.isFork`. Those are not the same predicate: `isFork` is true on *every*
skip a fork PR takes, so a fork PR dropped by the run lock, by a deferred review
or by the head-SHA dedup each used to earn "I can't apply fixes to this PR" —
an explanation of a decision that was not taken — once per skip, for the life of
the PR. Unlike an escalation it is never invalidated by a push: an escalation
says "this problem needs a human", which a new commit can make untrue; a fork
notice says "your branch is not on this repo", which pushing to that same fork
does not change.

The **cost window** the `budget-exhausted` case reads is scoped to the current
PROBLEM, not to the PR's lifetime — the same `sameProblem` boundary that re-arms
the attempt counter. `fix.maxAttempts` and `fix.maxCostUsd` bound the same
window, so a maintainer's push has to re-arm both or neither: re-arming only the
counter meant the `escalated:` guard fell away and the very next event fell
straight back through `budget-exhausted`, posting another `requires-human`
comment — a comment whose own closing paragraph tells the maintainer that
pushing is the remedy. `PrState.costBaselineUsd` carries the offset forward and
is re-stamped to the lifetime total when someone else pushes, **or when a retry
is recorded**: one predicate (`sameProblem`) moves both budgets, because a
second budget shape is how the six-sites-disagreeing situation started.

`fix.maxCostUsd` is therefore a **futility guard, not a spend guard**. It is
scoped to a problem and re-armed by any human intervention, which is futility
logic; a real spend cap belongs at server level and does not exist yet. With
unbounded full-window retries that cap becomes the only backstop, which is why
it is a prerequisite rather than an enhancement.

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
| PR snapshot | `src/engine/pr-state.ts` |
| The PR-scoped set (the run lock's span), from `pr_scoped:` metadata | `src/workflows/pr-scope.ts` |
| Pure decisions over the snapshot | `src/engine/pr-decisions.ts` |
| Escalation (label + one comment + the run row) | `src/engine/pr-escalation.ts` |
| Retry record (`PrState.intervention`, `recordIntervention`) | `src/engine/pr-state.ts`, `src/engine/pr-escalation.ts` |
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
  comment and every Slack message, so cost it. A local SQLite file handles
  it trivially; on the Postgres runtime it is one round trip on an indexed
  column, and a re-implementation on a *remote* DB should cache the active
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

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
managed-repos set, and optional model overrides for the classifier
and screener.

Defined in `src/engine/router.ts:8–40`.

## Deterministic routes

These run before any LLM call. For every envelope, the first matching
rule wins.

| Trigger | Result | Notes |
|---|---|---|
| `issue.opened` / `issue.reopened` | `skill: issue-triage` | `reopened=true` for the latter |
| `pr.opened` / `pr.synchronize` / `pr.reopened` | `skill: pr-review` | |
| `comment.created` with pending reply gate | `skill: explore-reply` | Reply-gate short-circuit — see below |
| `comment.created` without `@last-light` | `ignore` | reason: "no bot mention" |
| `comment.created` from non-maintainer | `reply: "only maintainers can trigger builds"` | `authorAssociation` not in `MAINTAINER_ROLES` |
| `comment.created` matching `@last-light approve\|reject [reason]` | `skill: approval-response` | Regex parse, no classifier |
| `comment.created` matching `@last-light security-review` | `skill: security-review` | |
| `comment.created` matching `@last-light verify <claim>` | `skill: verify` | Text after the keyword becomes `commentBody`; works on issues + PRs |
| `comment.created` matching `@last-light qa-test <target>` | `skill: qa-test` | Text after the keyword becomes `commentBody`; works on issues + PRs |
| `comment.created` on issue with `security-scan` label | `skill: security-feedback` | Overrides classifier — every comment on a scan summary issue is feedback |
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
// src/engine/screen.ts:47
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

The classifier turns a free-form comment or message into one of thirteen
discrete intents:

```
BUILD | EXPLORE | QUESTION | TRIAGE | REVIEW | SECURITY |
VERIFY | QATEST | APPROVE | REJECT | STATUS | RESET | CHAT
```

(`VERIFY` → the `verify` workflow, `QATEST` → `qa-test`. The structured
`@last-light verify` / `@last-light qa-test` keyword matches above short-circuit
before the classifier; natural-language requests like "does this actually fix
the crash?" reach `verify` via this classifier path.)

`classifier.ts:39–96` defines the system prompt. The model must reply
in exactly four lines:

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

## `llm.ts` — the cheap-helper path

Both screener and classifier dispatch through `src/engine/llm.ts`,
which does direct HTTP POSTs to provider APIs (Anthropic Messages,
OpenAI Chat Completions, OpenRouter passthrough). No agent SDK, no
tools, no streaming — single-turn calls only.

Provider auto-detection at `llm.ts:91–105`:

1. `OPENCODE_MODELS` JSON for the relevant key (`screener`, `classifier`)
2. `ANTHROPIC_API_KEY` set → `anthropic/claude-haiku-4-5-20251001`
3. `OPENAI_API_KEY` set → `openai/gpt-5.4-mini`
4. `OPENROUTER_API_KEY` set → `openrouter/google/gemini-2.5-flash`

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
| `pr-fix` | `689–744` — lightweight fix-and-push |
| `github-orchestrator` | `896–976` — full build cycle on an issue |
| `answer` | `982–1014` — generic `dispatchWorkflow()` for `answer.yaml`; answers a question issue directly (routed via `routes.github.issue_answer` / `routes.slack.answer`) |
| `pr-review`, `pr-comment`, `issue-triage`, `issue-comment`, `explore`, `security-review`, `security-feedback`, `verify`, `qa-test` | `982–1014` — generic `dispatchWorkflow()` + ack |

The generic-dispatch lane runs the YAML workflow whose name matches
the skill string. Anything bespoke (e.g. `github-orchestrator` first
records an `execution` row and reacts 🚀 on the comment before
dispatching) gets its own branch.

## Invariants

- **No LLM in deterministic routes.** The opening / synchronize / open
  events route by event type. The LLM never decides whether to triage
  an issue.
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
| Build-intent classifier | `src/engine/classifier.ts` |
| Injection screener | `src/engine/screen.ts` |
| Direct provider calls + model auto-detect | `src/engine/llm.ts` |
| Harness consumer (skill → handler) | `src/index.ts:560–1124` |
| URL extraction fallback | `extractGithubRefFromText()` in `classifier.ts:182–189` |

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
- **Treat the classifier prompt as code.** A change to the intent set,
  the output format, or the fallback rules ripples through every chat
  surface. Version it like a config file; test it with golden cases.

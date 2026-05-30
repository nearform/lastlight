---
title: "Integrations"
order: 3
description: "Every event source: GitHub App webhooks, Slack Bolt/Socket Mode, the CLI, the built-in cron scheduler, and admin-dashboard triggers. The connector contract, authentication, normalization, and reply path for each."
---

## Purpose

Integrations are the only way work enters Last Light. Each one
authenticates inbound traffic, normalizes the platform-specific payload
into an [EventEnvelope](/spec/04-event-model), and exposes a `reply()`
callback the engine uses to post results back. Agent runtimes, LLM
providers, and web-search tools are *not* integrations — they live
inside the [Sandbox](/spec/09-sandbox) and never produce inbound events.

There are five sources:

1. **GitHub App webhook** — issues, PRs, comments, reviews
2. **Slack** (Bolt + Socket Mode) — chat threads
3. **CLI** — ad-hoc dispatch via the running harness
4. **Cron** — scheduled workflow runs
5. **Admin dashboard** — operator-initiated dispatch and resume

Cron and CLI are slightly different from the other three: they don't
produce EventEnvelopes — they dispatch workflows directly. They're still
event sources from the system's perspective, just by-passing the
EventEnvelope abstraction.

## The connector contract

```ts
interface Connector {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: "event", handler: (env: EventEnvelope) => Promise<void>): void;
}
```

Defined in `src/connectors/types.ts`. The `ConnectorRegistry`
(`src/connectors/index.ts`) holds the list, wires each connector's
`event` emitter to a single central handler installed by the harness
(`src/index.ts:560`), and provides `startAll()` / `stopAll()` for boot
and shutdown.

Messaging connectors (Slack, future Discord) share an additional base —
`MessagingConnector` (`src/connectors/messaging/base.ts`) — which adds
session management, allowlist enforcement, and message chunking.

## 1. GitHub App webhook

| | |
|---|---|
| **Transport** | HTTP POST to `/webhooks/github` on the Hono app the GitHub connector exposes |
| **Auth** | HMAC-SHA256 over the request body, header `X-Hub-Signature-256`. Timing-safe compare. Runs *before* JSON parse. (`src/connectors/github-webhook.ts:146–155`) |
| **Allowlist** | Repo allowlist check via `isManagedRepo()` (`line 128`). Events from non-managed repos short-circuit, even if the GitHub App is installed there. |
| **Normalize** | `GitHubWebhookConnector.normalize()` (`line 157–260`). Runs *after* signature + allowlist. Returns `null` for ignored actions (does not produce an envelope). |
| **Event types** | `issue.opened`, `issue.reopened`, `issue.closed`, `pr.opened`, `pr.synchronize`, `pr.reopened`, `pr.closed`, `pr.merged`, `comment.created`, `pr_review.submitted`, `pr_review_comment.created` |
| **Filtered out** | `IGNORED_ACTIONS` (line 27): `edited`, `labeled`, `unlabeled`, `assigned`, `closed` (except for the explicit close types above), `pinned`, `transferred`, and friends. Bot self-events are dropped unless the bot opened/synchronised a PR (line 96). |
| **Reply** | Posts a comment via `replyFn(owner, repo, issueNumber, msg)` (line 237). Returns `Promise<void>`; no useful return value. No-op if `replyFn` or issue context is missing. |

If `WEBHOOK_SECRET` is empty (allowed but warned during boot), signature
verification is disabled. Production deployments must set it.

## 2. Slack (Bolt + Socket Mode)

| | |
|---|---|
| **Transport** | WebSocket connection initiated by Bolt to Slack's Socket Mode endpoint. No public URL needed. (`src/connectors/slack/connector.ts:57`) |
| **Auth** | `botToken` + `appToken` validated by Bolt SDK at construction. The user-level `SLACK_ALLOWED_USERS` allowlist is enforced in `MessagingConnector.handleIncomingMessage()` (`base.ts:50–54`) *before* envelope construction. |
| **Normalize** | `MessagingConnector.handleIncomingMessage()` (`base.ts:47–121`). Slack-specific mention stripping via `stripBotMention()` (line 124). Session info (channel id, thread id, platform user id) goes into `envelope.raw`, not into top-level fields. |
| **Event types** | `message` only. All Slack inbound traffic — DMs and `app_mention` in channels — normalizes to this one type. |
| **Filtered out** | Bot messages and non-text subtypes (edits, deletes) at `connector.ts:134–139`. Channel messages that aren't mentions or thread replies. |
| **Reply** | `reply(msg)` calls `sendMessage(channelId, threadId, chunk)` per chunk; long messages are chunked to respect Slack's ~3000-char limit. Replies post into the originating thread when one exists. (`base.ts:89–99`) |

The chat skill running on top of Slack messages is *not* a connector
concern — see [Chat](/spec/11-chat).

## 3. CLI

| | |
|---|---|
| **Transport** | HTTP POST from `src/cli.ts` to the running harness. `POST /api/run` (generic workflow dispatch) or `POST /api/build` (build cycle on an issue URL). |
| **Auth** | `Authorization: Bearer <token>` header. The token is issued by `POST /admin/api/login` after the CLI submits `LASTLIGHT_TOKEN` (which the operator sets to match `ADMIN_PASSWORD`). HMAC-signed, 7-day TTL. Verified by `authMiddleware()` (`src/admin/auth.ts:35–65`). |
| **Normalize** | None — the CLI does not produce an EventEnvelope. The `/api/run` handler unpacks `{ workflow, context }` and calls `dispatchWorkflow()` directly (`src/index.ts:495–518`). Workflows triggered this way see `_triggerType: "api"` in their context. |
| **Event types** | n/a |
| **Reply** | HTTP 202 with `{ accepted: true, executionId, workflow }`. The CLI does not stream output — operators check the dashboard or server logs. |

The endpoints live on the Hono app the GitHub webhook connector
provides. Without a GitHub App configured there is no HTTP server, so
the CLI cannot reach the harness. A pure chat-only deployment runs
without the CLI.

## 4. Cron

| | |
|---|---|
| **Transport** | In-process function calls. The harness owns a `CronScheduler` (`src/cron/scheduler.ts`) backed by the `croner` library. |
| **Auth** | None — cron jobs run with implicit process trust. |
| **Normalize** | None — cron jobs dispatch workflows directly. `_triggerType: "cron"` is added to the workflow context (`src/cron/fanout.ts:42`). |
| **Event types** | n/a |
| **Job source** | `workflows/cron-*.yaml` files. `getJobs({ webhooksEnabled, db })` (`src/cron/jobs.ts`) loads them, applies DB overrides from `cron_overrides`, and filters those marked `condition: { unless: webhooksEnabled }` when webhooks are active. |
| **Fan-out** | `dispatchCronWorkflow()` (`src/cron/fanout.ts:36–76`) fans out across a `repos` array in the context with a concurrency limit (default 3). Each per-repo dispatch is its own workflow run with its own taskId. |
| **Reply** | Cron jobs don't reply per se. Output destined for humans flows through `SLACK_DELIVERY_CHANNEL` when configured. |

The dual webhook/poll model is intentional: with webhooks enabled, the
polling crons (`cron-triage`, `cron-review`) silently de-register; with
webhooks disabled, they kick in to keep parity. The scheduled crons
(`cron-health`, `cron-security`) run regardless.

## 5. Admin dashboard

| | |
|---|---|
| **Transport** | HTTP POST to admin routes under `/admin` (e.g. `/admin/approvals/:id/respond`, `/admin/crons/:name/toggle`), or in-process callback for workflow resume. |
| **Auth** | Same as CLI — bearer token or session cookie verified by `authMiddleware()`. Login is via `ADMIN_PASSWORD` or one of the configured OAuth providers (Slack, GitHub). |
| **Normalize** | None — dashboard actions dispatch workflows directly. Workflows triggered this way see `_triggerType: "admin"`. |
| **Event types** | n/a |
| **Resume** | When an operator approves a paused workflow, `/admin/approvals/:id/respond` calls `config.resumeWorkflow(workflowRun, "admin")` — the same callback the GitHub `@last-light approve` comment and Slack `/approve` slash command use. (`src/admin/routes.ts:813–831`, callback wired at `src/index.ts:453–476`) |
| **Cron management** | Schedule overrides and enable/disable land in `cron_overrides`; the scheduler applies them on next tick without a process restart. |

## Invariants

- **One handler in, one envelope out.** Every connector's `event` emitter
  feeds the central `registry.onEvent()` handler in the harness. There is
  no second path for events.
- **Auth before normalize.** Both GitHub (HMAC) and Slack (allowlist)
  check before constructing an envelope. A failed auth never produces
  one.
- **Normalize before route.** The router (`src/engine/router.ts`) only
  sees fully-normalized envelopes. Platform-specific shape never crosses
  into it.
- **Bot self-loop prevention is in the connector.** GitHub events from
  the bot itself are dropped at the connector layer, not at the router.
  The exception (bot opening / synchronizing a PR) is also a connector
  decision — the router doesn't know the difference.
- **CLI, cron, and admin do not produce envelopes.** They call
  `dispatchWorkflow()` directly, marking the context with `_triggerType`.
  This is a deliberate asymmetry: those sources don't have a
  platform-payload-to-normalize, they have a workflow name + a context
  dict.
- **No reply guarantees.** `reply()` is fire-and-forget. GitHub doesn't
  return the comment URL; Slack doesn't return the message TS. Callers
  that need the resulting artifact must fetch it separately.

## Current implementation

| Piece | File |
|---|---|
| Connector contract + EventEnvelope type | `src/connectors/types.ts` |
| Registry (`startAll`/`stopAll`/`onEvent`) | `src/connectors/index.ts` |
| GitHub webhook connector | `src/connectors/github-webhook.ts` |
| Messaging base (allowlist, sessions, chunking) | `src/connectors/messaging/base.ts` |
| Slack connector | `src/connectors/slack/connector.ts` |
| CLI client | `src/cli.ts` |
| API endpoints (`/api/run`, `/api/build`) | `src/index.ts:481–557` |
| Cron scheduler | `src/cron/scheduler.ts` |
| Cron job loader | `src/cron/jobs.ts` |
| Cron fan-out | `src/cron/fanout.ts` |
| Admin routes (including approval/cron mutations) | `src/admin/routes.ts` |

## Rebuild notes

- **Define the connector contract first, write integrations second.**
  The asymmetry (some sources normalize to envelopes, others dispatch
  directly) is workable but only if the entry points are clearly typed.
  In TypeScript that's the `Connector` interface plus the
  `dispatchWorkflow()` signature; in Go that would be two interfaces.
- **One HTTP server, mounted by the GitHub connector, used by everyone.**
  Resist the urge to give the admin dashboard or CLI endpoints their
  own listener. One auth surface, one TLS termination, one port to
  expose. If you don't run the GitHub integration, you don't get any
  HTTP surfaces — chat-only deployments are fine that way.
- **Filtering is connector business, not router business.** The router
  should only see events the system actually cares about. Bot
  self-loops, ignored actions, non-managed repos — drop them at the
  source.
- **Session metadata in `raw`, not on the envelope.** Slack channel,
  thread, and platform-user IDs stay in `envelope.raw` so the canonical
  schema doesn't bloat with platform-specific fields. The chat skill
  reads them back when it needs to route a reply to the right thread.
- **Cron is just a scheduler over the same dispatch.** Don't build a
  parallel "cron workflow engine". The dispatcher signature is the same
  — cron just calls it on a clock instead of a webhook.
- **Auth + allowlist before envelope.** A re-implementation that builds
  the envelope first and then checks auth wastes work and leaks
  metadata about denied events through traces and logs. Keep the
  pattern.

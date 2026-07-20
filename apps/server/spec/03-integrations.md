---
title: "Integrations"
order: 3
description: "Every event source: GitHub App webhooks, Slack (HTTP Events API webhook, Socket Mode dev fallback), the CLI, the built-in cron scheduler, and admin-dashboard triggers. The connector contract, authentication, normalization, and reply path for each."
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
2. **Slack** (HTTP Events API webhook, default; Socket Mode dev fallback) — chat threads
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
| **Allowlist** | Repo allowlist check via `isManagedRepo()`. Events from non-managed repos short-circuit. The effective list is the overlay's `managedRepos` when non-empty; when empty it falls back to the repos the **GitHub App installation** can access (discovered at boot, kept live by installation webhooks — see below). So an org install that limits the App to a subset need not duplicate the list in config. |
| **Installation sync** | `installation` and `installation_repositories` events are intercepted at the top of the handler (before the ignored-action + repo filters, since they carry no `payload.repository`) and applied to the in-memory installation-repo cache: `created` seeds it, `deleted` clears it, `installation_repositories` added/removed patch it. They produce no envelope (return `installation-sync`, 200). See `src/managed-repos.ts`. |
| **Normalize** | `GitHubWebhookConnector.normalize()` (`line 157–260`). Runs *after* signature + allowlist. Returns `null` for ignored actions (does not produce an envelope). |
| **Event types** | `issue.opened`, `issue.reopened`, `issue.closed`, `pr.opened`, `pr.synchronize`, `pr.reopened`, `pr.closed`, `pr.merged`, `pr.checks_failed`, `pr.checks_passed`, `comment.created`, `pr_review.submitted`, `pr_review_comment.created` |
| **Re-run checks** | `check_run.rerequested` / `check_suite.rerequested` (the GitHub "Re-run" / "Re-run all checks" buttons) normalize to `pr.synchronize` for the PR in the event's `pull_requests[]`, re-triggering pr-review against the current head. Requires the App to subscribe to the **Check run** / **Check suite** events (App permission: Checks: read). |
| **Failed checks** | `check_suite.completed` with a `failure` / `timed_out` conclusion normalizes to `pr.checks_failed` for the PR in `pull_requests[]` (the head commit supplies the title + author signal). **Settle-aware:** the connector emits only once the head SHA's checks have *fully settled red* (`getChecksConclusion === "failing"` — nothing pending), so a repo with several check-reporting apps fires one event per SHA, not one per suite. The router runs it through the intent classifier so a workflow that claims a check-failure intent via its `classification` block (e.g. `dependabot-ci-fix`) is picked up; unclaimed → ignored. Requires the **Check suite** subscription (Checks: read). |
| **Passed checks** | `check_suite.completed` with a `success` conclusion normalizes to `pr.checks_passed`, but **only for dependency-update PRs** — the connector pre-filters on the head commit author (`dependabot[bot]` / `renovate[bot]`) or the suite's head branch (`dependabot/` / `renovate/`) so an ordinary green PR fires nothing. **Settle-aware:** it emits only when the head SHA has *fully settled green* (`getChecksConclusion === "passing"`); an earlier suite going green while siblings are still running sees `"pending"` and is dropped, so exactly one event fires per SHA — the last suite to settle. The router routes it deterministically (no classifier call) to the workflow claiming the `dependabot-pr-merge` intent; unclaimed → ignored. Same **Check suite** subscription (Checks: read). |
| **Filtered out** | `IGNORED_ACTIONS` (line 27): `edited`, `labeled`, `unlabeled`, `assigned`, `closed` (except for the explicit close types above), `pinned`, `transferred`, and friends. Bot self-events are dropped unless the bot opened/synchronised a PR **or** it's a `check_suite.completed` (the failing-CI signal is always bot-sent); a PR **authored** by the bot is dropped from pr-review entirely (self-review guard). |
| **Reply** | Posts a comment via `replyFn(owner, repo, issueNumber, msg)` (line 237). Returns `Promise<void>`; no useful return value. No-op if `replyFn` or issue context is missing. |

If `WEBHOOK_SECRET` is empty (allowed but warned during boot), signature
verification is disabled. Production deployments must set it.

## 2. Slack (HTTP Events API, default; Socket Mode dev fallback)

| | |
|---|---|
| **Transport** | `SLACK_MODE=webhook` (default): Slack POSTs events to `POST /webhooks/slack` on the shared Hono app (the same server as the GitHub webhook). At-least-once — Slack retries failed deliveries. `SLACK_MODE=socket` (dev fallback): a Bolt WebSocket to Slack's Socket Mode endpoint, no public URL, but at-most-once (can silently drop messages under bursts). Sending uses a `WebClient` in both modes. (`src/connectors/slack/connector.ts`) |
| **Auth** | webhook: HMAC-SHA256 over `v0:{timestamp}:{body}` with `SLACK_SIGNING_SECRET`, header `X-Slack-Signature`, timing-safe compare + a 5-minute timestamp replay window (`verifySlackSignature`); the `url_verification` handshake is answered and retries are deduped by `event_id`. socket: `botToken` + `appToken` validated by Bolt. The user-level `SLACK_ALLOWED_USERS` allowlist is enforced in `MessagingConnector.handleIncomingMessage()` *before* envelope construction. |
| **Normalize** | Both transports feed the same `onMessageEvent` / `onAppMention` handlers → `MessagingConnector.handleIncomingMessage()`. Slack-specific mention stripping via `stripBotMention()`. Session info (channel id, thread id, platform user id) goes into `envelope.raw`, not into top-level fields. |
| **Event types** | `message` only. All Slack inbound traffic — DMs (`message.im`) and `app_mention` in channels — normalizes to this one type. |
| **Filtered out** | Bot messages and non-text subtypes (edits, deletes); every inbound is logged (`[slack] inbound msg …`) *before* filtering so drops are diagnosable. Channel messages that aren't mentions or thread replies. |
| **Reply** | `reply(msg)` calls `sendMessage(channelId, threadId, chunk)` per chunk; long messages are chunked to respect Slack's ~3000-char limit. Replies post into the originating thread when one exists. Markdown is converted to Slack mrkdwn (`src/connectors/slack/mrkdwn.ts`): GFM tables render as aligned monospace code blocks (per-column width cap + total-width budget, with a `*label*: value` fallback for wide 2-column tables), since Slack mrkdwn has no table syntax. Markdown **images** (`![alt](url)`) are auto-promoted to Block Kit `image` blocks (`markdownToSlackBlocks`) — the mrkdwn path can only downgrade them to links — with a plain-text fallback if Slack rejects the blocks (e.g. an unreachable URL). |
| **Progress** | Workflow progress renders as a Block Kit checklist (a `header` + `context` meta + `divider` + sectioned steps with per-status emoji, via `renderProgressBlocks`) edited in place through `chat.update`, with the rendered markdown kept as the `text:` notification/accessibility fallback. The GitHub transport consumes the same `ProgressModel` as markdown — one content source, two renderings (`src/notify/`). |
| **Interactivity** | Approval gates post Approve/Reject buttons (Block Kit `actions`, `renderApprovalBlocks`). Slack POSTs a click to `POST /webhooks/slack/interactions` (signature-verified like events; deduped by `trigger_id`); it routes into the same `approval-response` resolution as the `/approve` slash command / `@last-light approve` comment, and the prompt message is rewritten to a button-free resolved state. `onApprovalAction` is wired in `src/index.ts`; socket mode uses Bolt `action` listeners. |

The chat skill running on top of Slack messages is *not* a connector
concern — see [Chat](/spec/11-chat).

## 3. CLI

| | |
|---|---|
| **Transport** | HTTP POST from `src/cli/cli.ts` to the running harness. `POST /api/run` (generic workflow dispatch) or `POST /api/build` (build cycle on an issue URL). |
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
| **Fan-out** | `dispatchCronWorkflow()` (`src/cron/fanout.ts:36–76`) fans out across a `repos` array in the context with a concurrency limit (default 3). Each per-repo dispatch is its own workflow run with its own taskId. A cron whose context sets `discover: <key>` instead fans out **per PR**: the runner (`src/index.ts`) resolves the key to a discoverer, finds the eligible dependency PRs in code (`src/cron/dependabot-discovery.ts`), and dispatches one bounded single-PR run each via `fanOutContexts`. |
| **Reply** | Cron jobs don't reply per se. Output destined for humans flows through `SLACK_DELIVERY_CHANNEL` when configured. |

The dual webhook/poll model is intentional: with webhooks enabled, the
polling crons (`cron-triage`, `cron-review`) silently de-register; with
webhooks disabled, they kick in to keep parity. The scheduled crons
(`cron-health`, `cron-security`) run regardless.

Two of the scheduled crons are **dependency-PR discovery backstops** for the
`pr.checks_passed` / `pr.checks_failed` webhooks — additive (no
`unless: webhooksEnabled`), so they also run with webhooks on:

- `merge-green-dependency-prs` (`discover: green-dependency-prs`, daily 14:00) —
  finds green (`mergeable_state === "clean"`) dependency PRs and fans out
  `dependabot-pr-merge`.
- `fix-red-dependency-prs` (`discover: red-dependency-prs`, daily 15:00) — finds
  dependency PRs that can't merge on their own and that `dependabot-ci-fix` can
  push toward: a settled-red check conclusion (failing/timed-out via
  `GitHubClient.getChecksConclusion`, so it never fires on a mid-flight suite),
  **or** a `mergeable_state` of `behind` (needs a base merge), `dirty` (merge
  conflict), or `blocked` (a required gate unmet). Failing CI wins the reported
  `reason` (`checks-failing` | `behind` | `dirty` | `blocked`). It fans out
  `dependabot-ci-fix` with the PR head `branch` (pre-clone) and the `reason`
  (threaded into the prompt as `{{reason}}`). `clean` is the green sweep's;
  `unstable` is covered by the checks conclusion; `unknown` is left for a later
  tick.

Both sweeps **skip any PR carrying the `requires-human` label** — the terminal
flag the dependabot prompts apply when Last Light can't proceed (a functional
merge, or a CI fix it couldn't complete) — so the nightly crons don't re-attempt
what we already know we can't land. The **webhook path** now honors it too: the
dispatcher applies a pre-sandbox idempotency guard on the two dependency check
events (one PR read) that skips a PR carrying `requires-human`, **or** one whose
current head SHA equals the SHA of the last successful assessment (a re-fired
suite / cron overlap). A genuinely new push (new head SHA, no `requires-human`)
still runs once, and an explicit human `@bot` comment is an intentional override
that the guard does **not** gate.

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
| CLI client | `src/cli/cli.ts` |
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

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
| **Event types** | `issue.opened`, `issue.reopened`, `issue.closed`, `pr.opened`, `pr.synchronize`, `pr.reopened`, `pr.closed`, `pr.merged`, `pr.checks_failed`, `pr.checks_passed`, `pr.checks_settled`, `pr.labeled`, `pr.review_requested`, `comment.created`, `pr_review.submitted`, `pr_review_comment.created` |
| **Review signals** | Three `pull_request` actions carry the `review.trigger` machinery. `ready_for_review` normalizes to **`pr.opened` semantics** — a draft becoming ready is the moment the PR first asks to be looked at, and it is the event that un-defers a review `review.skipDraft` held back. `labeled` normalizes to `pr.labeled` carrying `addedLabel`, so `review.requestLabel` works; every other label is hard-ignored by the router, so the widening costs a `normalize()` call rather than a dispatch. `review_requested` normalizes to `pr.review_requested` carrying `requested_reviewer.login` (or `team/<slug>`) — **opportunistic only**: GitHub App bot users are not selectable in the reviewer picker, so `on-request` mode must not depend on it, and the label + comment + Re-run paths are the real mechanism. All three inherit the self-review guard: a PR the bot authored is dropped. |
| **Re-run checks** | `check_run.rerequested` / `check_suite.rerequested` (the GitHub "Re-run" / "Re-run all checks" buttons) normalize to `pr.synchronize` for the PR in the event's `pull_requests[]`, re-triggering pr-review against the current head. **Exception:** a re-run of *our own* `last-light/review` check normalizes to `pr.review_requested` instead — it is a human asking for a review, not "the code changed", and `pr.synchronize` is a PR-attention event that `after-checks` / `on-request` would defer, which would make the check's own button a no-op. Requires the App to subscribe to the **Check run** / **Check suite** events (App permission: Checks: read). |
| **Failed checks** | `check_suite.completed` with a `failure` / `timed_out` conclusion normalizes to `pr.checks_failed` for two populations: a **dependency-update PR** (head commit author `dependabot[bot]` / `renovate[bot]`, or a `dependabot/` / `renovate/` head branch — commit author *or* branch, so a squashed or proxied bot commit still matches), **and** a PR whose head commit **we** pushed (`head_commit.author.name === botLogin`, which is exactly what `git-auth.ts` stamps on the agent's own commits). The second is the CI feedback loop `pr-fix` never had: it could push a fix and never learn whether the build went green, because this event only ever fired for dependency PRs. It stays bounded — it cannot fire on a human PR the bot has not touched — but it is the one gate here that can raise run volume on non-dependency PRs. **Settle-aware:** the connector emits only once the head SHA's checks have *fully settled red* (`getChecksConclusion === "failing"` — nothing pending), so a repo with several check-reporting apps fires one event per SHA, not one per suite. The dependency discriminator is **carried on the envelope** as `isDependencyPr` rather than discarded, so the router routes on it deterministically (dependency → `dependabot-ci-fix`, otherwise → `pr-fix`) instead of paying a classifier call to re-guess it — see [Router](/spec/05-router). Requires the **Check suite** subscription (Checks: read); reading the *reason* it failed additionally wants **Actions: read** — see below. |
| **Settled checks** | Under `review.trigger: after-checks` — and only then, since emitting is what costs event volume — a settled `check_suite.completed` on a PR that **neither** check-outcome route below claimed normalizes to `pr.checks_settled`, either colour. This is the `after-checks` trigger. It is a separate event type rather than a broadening of `pr.checks_failed` because `normalize()` returns **one envelope per delivery** and `route()` returns one handler: a fan-out into both a fix and a review is not expressible, so **fix outranks review** by construction. The gap that leaves — a fix chain that ends without pushing, so no further `check_suite` ever fires — is released by the `check-prs-awaiting-review` sweep. |
| **Passed checks** | `check_suite.completed` with a `success` conclusion normalizes to `pr.checks_passed`, but **only for dependency-update PRs** — the connector pre-filters on the head commit author (`dependabot[bot]` / `renovate[bot]`) or the suite's head branch (`dependabot/` / `renovate/`) so an ordinary green PR fires nothing. **Settle-aware:** it emits only when the head SHA has *fully settled green* (`getChecksConclusion === "passing"`); an earlier suite going green while siblings are still running sees `"pending"` and is dropped, so exactly one event fires per SHA — the last suite to settle. The router routes it deterministically (no classifier call) to the workflow claiming the `dependabot-pr-merge` intent; unclaimed → ignored. Same **Check suite** subscription (Checks: read). |
| **Filtered out** | `IGNORED_ACTIONS`: `edited`, `unlabeled`, `assigned`, `closed` (except for the explicit close types above), `pinned`, `transferred`, and friends. `labeled` left the set when `review.requestLabel` landed. Bot self-events are dropped unless the bot opened/synchronised a PR **or** it's a `check_suite.completed` (the failing-CI signal is always bot-sent); a PR **authored** by the bot is dropped from pr-review entirely (self-review guard). |
| **Reply** | Posts a comment via `replyFn(owner, repo, issueNumber, msg)` (line 237). Returns `Promise<void>`; no useful return value. No-op if `replyFn` or issue context is missing. |

If `WEBHOOK_SECRET` is empty (allowed but warned during boot), signature
verification is disabled. Production deployments must set it.

### App permission: `Actions: read` (optional, recommended)

`Checks: read` gets the harness the check *runs* — names, conclusions, and annotations. It does **not** get it the GitHub Actions **job logs** behind them. That is a separate App permission, `Actions: read`, and it is **not** the same thing as `Workflows: write` (which only governs pushing files under `.github/workflows/`).

`GitHubClient.getCiFailureReport` (`src/engine/github/github.ts`) attempts three Actions reads per failed check run — `downloadJobLogsForWorkflowRun`, `getJobForWorkflowRun` (for the failing step) and `getWorkflowRun` (for the workflow's `path`) — and falls back to check-run annotations when they are denied. Nothing hard-fails without the permission: it is deliberately optional so an existing installation is never broken by not re-consenting.

What the permission changes is the *quality* of the evidence, and its absence is now stated rather than inferred. When no failed job could supply a real log, the rendered `{{ciSection}}` is prefixed with:

```
NOTE: GitHub Actions job logs are unavailable (the App lacks `Actions: read`).
The excerpts below are check-run annotations only, which are usually truncated.
Grant Actions: read for full CI output.
```

The notice is suppressed when none of the failed checks is a GitHub Actions job (a CircleCI-only repo has no Actions logs to be missing, so blaming the permission there would be wrong). The same permission backs agentic-pi's `github_list_workflow_runs` / `github_list_workflow_run_jobs` / `github_get_job_logs` tools, which return `{ ok: false, reason }` rather than throwing when it is absent.

### Harness-side writes (`GitHubClient`)

The three settle-aware check queries — `getChecksConclusion`,
`getChecksSummary`, `getBaseChecksState` — take an `excludeApp` option, and
every **trigger-side** caller passes our own `botName`. Without it a
`last-light/review` check that is `queued` (waiting for CI under
`after-checks`) or `in_progress` pins the aggregate at `pending`: the settle
event never fires, the review never runs, the check never concludes, and a
repo that made it a *required* check has an unmergeable PR forever. See
[Router](/spec/05-router#the-last-lightreview-check-is-a-projection-of-run-state).

`src/engine/github/github.ts` is the harness's own Octokit client — App-authed, and deliberately *not* the surface agents use (they get agentic-pi's `github_*` tools inside the sandbox, gated per permission profile). Its write surface is small on purpose: comments (`postComment` / `updateComment` / `deleteComment`), reactions, review posting, the `last-light/review` check run — and one label write, `addLabels`.

`addLabels` is the exception that proves the rule. Every other label mutation in the system happens *inside* a sandbox, driven from a prompt, because the label's value is an agent's judgement (`dependency-trivial`, the impact tiers, the triage vocabulary). The dispatch-time escalation is different in kind: it fires precisely when the gate has decided **not** to provision a sandbox, so there is no agent to ask — see [Router](/spec/05-router#escalation--the-skips-that-are-not-silent). GitHub's endpoint creates a label that does not exist yet, so there is no `ensureLabels` companion, and adding a label already present is a no-op — but idempotency at the API is *not* what makes the escalation comment once; the persisted escalation row is (see [State](/spec/10-state)). It needs no new App permission: writing labels is part of the `Issues: write` / `Pull requests: write` grants the App already holds.

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
| **Transport** | HTTP POST from `packages/cli/src/cli.ts` to the running harness. `POST /api/run` (generic workflow dispatch) or `POST /api/build` (build cycle on an issue URL). `lastlight pr retry` is the one trigger that goes to an **admin** route instead — `POST /admin/api/prs/:owner/:repo/:number/retry`, see below. |
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
| **Job source** | `workflows/cron-*.yaml` files. `getJobs({ webhooksEnabled, db, crons })` (`src/cron/jobs.ts`) loads them, applies DB overrides from `cron_overrides` **and** the operator's `crons.disable` list, and filters those marked `condition: { unless: webhooksEnabled }` when webhooks are active. A cron turned off by either lever stays **registered**, carrying `_cronGloballyEnabled: false` — see "Per-repo cron participation" below. |
| **Fan-out** | `dispatchCronWorkflow()` (`src/cron/fanout.ts`) fans out across a `repos` array in the context — **all at once, with no dispatch-side throttle**. Bounding concurrency is entirely the global admission cap's job (`concurrency.maxWorkflows`): each dispatch just creates a `workflow_runs` row, and an over-cap row is persisted `queued` and promoted as slots free. Each per-repo dispatch is its own workflow run with its own taskId. A cron whose context sets `discover: <key>` instead fans out **per PR**: the runner (`src/index.ts`) resolves the key to a discoverer, finds the eligible dependency PRs in code (`src/cron/dependabot-discovery.ts`), and dispatches one bounded single-PR run each via `fanOutContexts`. |
| **Reply** | Cron jobs don't reply per se. Output destined for humans flows through `SLACK_DELIVERY_CHANNEL` when configured. |

The dual webhook/poll model is intentional: with webhooks enabled, the
polling crons (`cron-triage`, `cron-review`) silently de-register; with
webhooks disabled, they kick in to keep parity. The scheduled crons
(`cron-health`, `cron-security`) run regardless.

**Per-repo cron participation (issue #180).** WHICH repos a tick fans out over is
resolved at **tick** time, not at registration: a managed repo may opt out of (or
into) a cron in its `.lastlight/lastlight.yml`, and that must take effect without
re-registering croner jobs. `jobs.ts` therefore carries two control keys on every
scheduled tick's context — `_cronName` (the only channel by which the tick learns
which cron it is; several crons can share one workflow) and
`_cronGloballyEnabled` — which `resolveCronRepos` (`src/cron/repo-crons.ts`)
consumes and the fan-out strips before dispatch, so a dispatched run's context is
byte-for-byte what it was before the feature existed. An empty resolved list is a
legitimate no-op tick: no dispatch, no run, no failure. The discovery crons
bypass `dispatchCronWorkflow` (they fan out per PR, not per repo), so
`src/index.ts` narrows their repo list through the same `resolveCronRepos` before
discovering anything. Cost: warm layers come from the in-memory cache, misses are
fetched concurrently and conditionally, and one repo's failure degrades to its
inherited behaviour. See [Configuration](/spec/02-configuration).

Two of the scheduled crons are **dependency-PR discovery backstops** for the
`pr.checks_passed` / `pr.checks_failed` webhooks — additive (no
`unless: webhooksEnabled`), so they also run with webhooks on:

- `merge-green-dependency-prs` (`discover: green-dependency-prs`, daily 14:00) —
  finds green (`mergeable_state === "clean"`) dependency PRs and fans out
  `dependabot-pr-merge`. With `dependencies.requireSettledChecks` on (the
  default) it additionally asks the head SHA's checks: `clean` is GitHub's
  *mergeability* verdict, not a CI verdict, and on a repo with **no required
  status checks** a PR whose checks are failing still reports `clean` — so
  without that second read the cron's notion of "green" and the webhook's
  would differ, and the difference is a merged red PR. Uniquely in this
  module that read fails **closed**: a dropped candidate costs one tick.
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

**Both discoverers are candidate finders, not policy.** They answer one
question — does this PR *look* like it needs this workflow? — and nothing else.
Whether we may act on it (the hold label, the escalation guard, the attempt
counter, the cost cap, the per-SHA dedup, the fork guard, the run lock) is
decided once, off the resolved PR snapshot, at the `dispatchWorkflow` choke point
the webhook route crosses too: see the
[dispatch gate](/spec/05-router#the-pr-scoped-dispatch-gate).

That split is a correction, not a tidy-up. The `requires-human` filter used to
live in the discoverers **and** in the dispatcher, and the two disagreed by
construction: on the cron side the label was a one-way door with no code path
that removed it, while the webhook path cleared it on success. Now there is one
answer, and it is stateful rather than label-based — the state is "we escalated
at head SHA X" (`PrState.escalatedAtSha`), so a maintainer's push re-arms the PR
automatically. `requires-human` itself is read by **nothing**: it is a
notification the bot writes, and the label a human applies to mean "stay off
this" is the separate **hold** label (`hold.label`, default `lastlight-ignore`),
answered at the same choke point above every other guard. See
[Router](/spec/05-router#the-hold--the-first-gate).

The same choke point is why the fan-out no longer bypasses enrichment. A cron
dispatch calls `dispatchWorkflow` directly and never crosses the dispatcher, so
every nightly `fix-red-dependency-prs` run used to carry `branch` + `reason` but
an **empty** `{{ciSection}}`, the repo's default branch instead of the PR's real
base, and no fork guard at all. One projection at one place makes the webhook
and cron dispatches of a `pr-fix`-shaped workflow identical by construction.

## 5. Admin dashboard

| | |
|---|---|
| **Transport** | HTTP POST to admin routes under `/admin` (e.g. `/admin/approvals/:id/respond`, `/admin/crons/:name/toggle`), or in-process callback for workflow resume. |
| **Auth** | Same as CLI — bearer token or session cookie verified by `authMiddleware()`. Login is via `ADMIN_PASSWORD` or one of the configured OAuth providers (Slack, GitHub). |
| **Normalize** | None — dashboard actions dispatch workflows directly. Workflows triggered this way see `_triggerType: "admin"`. |
| **Event types** | n/a |
| **Resume** | When an operator approves a paused workflow, `/admin/approvals/:id/respond` calls `config.resumeWorkflow(workflowRun, "admin")` — the same callback the GitHub `@last-light approve` comment and Slack `/approve` slash command use. (`src/admin/routes.ts:813–831`, callback wired at `src/index.ts:453–476`) |
| **Cron management** | Schedule overrides and enable/disable land in `cron_overrides`; the scheduler applies them on next tick without a process restart. **Disable re-registers rather than unregisters** — the job keeps ticking with `_cronGloballyEnabled: false` so a repo that opted into that cron from its `.lastlight/` is still honoured; usually the fan-out resolves to nobody and the tick costs nothing. "Run now" carries `_cronName` (so a repo's opt-out is respected however the tick was started) but deliberately *not* `_cronGloballyEnabled`, so the button still works on a globally-disabled cron. |
| **PR retry** | `POST /admin/api/prs/:owner/:repo/:number/retry`, body `{ "reason"?: string }` — the third of the three surfaces that re-arm a pull request the harness escalated (see [Router](/spec/05-router#un-sticking-an-escalated-pr--the-three-retry-surfaces)). It is the only surface with no event of its own, so it resolves a `PrState` with `intervention: { via: "api", by: <session actor>, note: reason }`, crosses `applyPrDispatchGate` **itself**, and dispatches on `run` — the route that resolves is the route that gates. The workflow retried is the one that last worked the PR (`latestForTrigger` over `PR_FIX_SHAPED_WORKFLOWS`), else the configured `github.pr_fix` route. |

The retry endpoint's answers, in full: **200** on dispatch (`dispatched: true`)
or on record-without-dispatch (`dispatched: false, recorded: true`); **409** when
the hold label, the run lock or a degraded read refuses it (nothing recorded);
**403** for a repo outside `managedRepos`; **400** for a non-positive PR number;
**503** when `github` / `dispatchWorkflow` are not wired (chat-only, CLI-only);
**401** unauthenticated, from the same `authMiddleware` as every other admin
route. `lastlight pr retry <owner/repo#N> [reason]` is a thin client over it and
renders exactly those three outcomes (see `packages/cli/CLAUDE.md`).

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

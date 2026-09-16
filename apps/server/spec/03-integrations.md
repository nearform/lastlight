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
| **Installation sync** | `installation` and `installation_repositories` events are intercepted at the top of the handler (before the ignored-action + repo filters, since they carry no `payload.repository`) and applied to the in-memory installation-repo cache, **scoped to `payload.installation.id`**: `created` / `unsuspend` set that installation's set, `deleted` / `suspend` remove it, `installation_repositories` added/removed patch it. A **suspended** installation still exists and keeps its id but 403s every mint, so it is out of service exactly like an uninstall — the only difference is that the directory keeps it visible, flagged, instead of forgetting it. They produce no envelope (return `installation-sync`, 200). Every delivery — these included — also records its `payload.installation` in the installation directory (below). See `src/managed-repos.ts`. |
| **Team-visibility sync** | `team`, `membership` and `organization` events are intercepted in the same place, and for the same reason: they are org-wide, carry no `payload.repository`, and several of their actions (`deleted`, `edited`) sit in `IGNORED_ACTIONS`. They **invalidate** the dashboard's per-repo visibility cache (issue #169) rather than re-derive it — `membership` and `organization` member changes drop that one login's answer, a `team` change drops the team and every member's answer with it. Deleting is the whole response because the cache is filled on demand per logged-in user; re-deriving here would put an unbounded org walk on the delivery path. They produce no envelope (return `team-visibility-sync`, 200). See `src/state/team-store.ts` and `10-state.md`. |
| **Board invalidation** | `issues` and `pull_request` deliveries whose action would change what the pipeline board renders (`opened`, `reopened`, `closed`, `labeled`, `unlabeled`, `transferred`, `deleted`, `ready_for_review`) drop that repo's cached board items. Intercepted in the same place as the two rows above and for a sharper version of the same reason: the single most important board signal is `closed`, which is how a merged PR or a closed issue LEAVES the board's universe (the GitHub read lists **open** items only) — and `closed`, `unlabeled` and `deleted` all sit in `IGNORED_ACTIONS`, so nothing below that line would ever hear about them. Unlike the two above it **does not consume the delivery**: there is no early return, so the event still normalizes and dispatches exactly as before. It is a side-effect, not a handler. It **invalidates** rather than re-derives, so a delivery for a repo nobody is looking at costs a `Map` miss, and it is deliberately *not* label-name-aware — the connector has no config access by design and cannot know which labels are configured stages. A hook that throws is swallowed: a cache that refuses to clear must never cost us a webhook. See `src/admin/board-cache.ts`. |
| **Normalize** | `GitHubWebhookConnector.normalize()` (`line 157–260`). Runs *after* signature + allowlist. Returns `null` for ignored actions (does not produce an envelope). |
| **Event types** | `issue.opened`, `issue.reopened`, `issue.closed`, `issue.labeled`, `pr.opened`, `pr.synchronize`, `pr.reopened`, `pr.closed`, `pr.merged`, `pr.checks_failed`, `pr.checks_passed`, `pr.checks_settled`, `pr.labeled`, `pr.review_requested`, `comment.created`, `pr_review.submitted`, `pr_review_comment.created` |
| **Review signals** | Three `pull_request` actions carry the `review.trigger` machinery. `ready_for_review` normalizes to **`pr.opened` semantics** — a draft becoming ready is the moment the PR first asks to be looked at, and it is the event that un-defers a review `review.skipDraft` held back. `labeled` normalizes to `pr.labeled` carrying `addedLabel`, so `review.requestLabel` works; every other label is hard-ignored by the router, so the widening costs a `normalize()` call rather than a dispatch. `review_requested` normalizes to `pr.review_requested` carrying `requested_reviewer.login` (or `team/<slug>`) — **opportunistic only**: GitHub App bot users are not selectable in the reviewer picker, so `on-request` mode must not depend on it, and the label + comment + Re-run paths are the real mechanism. All three inherit the self-review guard: a PR the bot authored is dropped. |
| **Re-run checks** | `check_run.rerequested` / `check_suite.rerequested` (the GitHub "Re-run" / "Re-run all checks" buttons) normalize to `pr.synchronize` for the PR in the event's `pull_requests[]`, re-triggering pr-review against the current head. **Exception:** a re-run of *our own* `last-light/review` check normalizes to `pr.review_requested` instead — it is a human asking for a review, not "the code changed", and `pr.synchronize` is a PR-attention event that `after-checks` / `on-request` would defer, which would make the check's own button a no-op. Requires the App to subscribe to the **Check run** / **Check suite** events (App permission: Checks: read). |
| **Failed checks** | A `check_suite.completed` whose head SHA has **settled red in aggregate** normalizes to `pr.checks_failed` for two populations: a **dependency-update PR** (head commit author `dependabot[bot]` / `renovate[bot]`, or a `dependabot/` / `renovate/` head branch — commit author *or* branch, so a squashed or proxied bot commit still matches), **and** a PR whose head commit **we** pushed (`head_commit.author.name === botLogin`, which is exactly what `git-auth.ts` stamps on the agent's own commits). The second is the CI feedback loop `pr-fix` never had: it could push a fix and never learn whether the build went green, because this event only ever fired for dependency PRs. It stays bounded — it cannot fire on a human PR the bot has not touched — but it is the one gate here that can raise run volume on non-dependency PRs. **Settle-aware:** the connector emits only once the head SHA's checks have *fully settled red* (`getChecksConclusion === "failing"` — nothing pending), so a repo with several check-reporting apps fires one event per SHA, not one per suite. **The delivering suite's own conclusion is not the discriminator** — see "Which event a settle becomes" below. The dependency discriminator is **carried on the envelope** as `isDependencyPr` rather than discarded, so the router routes on it deterministically (dependency → `dependabot-ci-fix`, otherwise → `pr-fix`) instead of paying a classifier call to re-guess it — see [Router](/spec/05-router). Requires the **Check suite** subscription (Checks: read); reading the *reason* it failed additionally wants **Actions: read** — see below. |
| **Settled checks** | Under `review.trigger: after-checks` — and only then, since emitting is what costs event volume — a settled `check_suite.completed` on a PR that **neither** check-outcome route below claimed normalizes to `pr.checks_settled`, either colour — **including a red aggregate observed through a green suite**, which is the ordinary shape of a PR with one failing job whose sibling suite finishes last. This is the `after-checks` trigger. It is a separate event type rather than a broadening of `pr.checks_failed` because `normalize()` returns **one envelope per delivery** and `route()` returns one handler: a fan-out into both a fix and a review is not expressible, so **fix outranks review** by construction. The gap that leaves — a fix chain that ends without pushing, so no further `check_suite` ever fires — is released by the `check-prs-awaiting-review` sweep. |
| **Passed checks** | A `check_suite.completed` whose head SHA has **settled green in aggregate** normalizes to `pr.checks_passed`, but **only for dependency-update PRs** — the connector pre-filters on the head commit author (`dependabot[bot]` / `renovate[bot]`) or the suite's head branch (`dependabot/` / `renovate/`) so an ordinary green PR fires nothing. **Settle-aware:** it emits only when the head SHA has *fully settled green* (`getChecksConclusion === "passing"`); an earlier suite going green while siblings are still running sees `"pending"` and is dropped, so exactly one event fires per SHA — the last suite to settle. Again the aggregate decides, not this suite's conclusion. The router routes it deterministically (no classifier call) to the workflow claiming the `dependabot-pr-merge` intent; unclaimed → ignored. Same **Check suite** subscription (Checks: read). |
| **Stage labels** | `issues.labeled` normalizes to `pr.labeled`'s issue-side twin, `issue.labeled`, carrying `addedLabel` and the issue's current `labels`. This is the software-factory pipeline's entry event: the router keeps it only when the label is a configured `autonomy.stages.*.enter`, so every other issue label is a hard router-level ignore and the widening costs a `normalize()` call rather than a dispatch. `issues.unlabeled` is **not** normalized — see [Event model](/spec/04-event-model) for why that is a decision rather than an omission. |
| **Filtered out** | `IGNORED_ACTIONS`: `edited`, `unlabeled`, `assigned`, `closed` (there are no "close types" — `issue.closed` / `pr.merged` are declared in `EventType` but **nothing emits them**, so a close produces no envelope at all; it is, however, intercepted *above* this filter for board invalidation, below), `pinned`, `transferred`, and friends. `labeled` left the set when `review.requestLabel` landed. Bot self-events are dropped unless the bot opened/synchronised a PR, it's a `check_suite.completed` (the failing-CI signal is always bot-sent), **or it's an `issues.labeled`** — see "The bot-sender filter's one issue-side hole" below; a PR **authored** by the bot is dropped from pr-review entirely (self-review guard). |
| **Reply** | Posts a comment via `replyFn(owner, repo, issueNumber, msg)` (line 237). Returns `Promise<void>`; no useful return value. No-op if `replyFn` or issue context is missing. |

If `WEBHOOK_SECRET` is empty (allowed but warned during boot), signature
verification is disabled. Production deployments must set it.

### The bot-sender filter's one issue-side hole

`issues.labeled` is admitted **even when our own bot is the sender**, and it is the only issue-side action that is. The reason is that the chain has to fire from a bot write: `issue-triage` applies `ready-for-agent` as the App, so a filter that dropped our own label events would mean the pipeline could only ever be started by a human, which is the opposite of the feature. The price is real and worth naming — each of the harness's own stage writes (`agent-building`, `ready-for-human`, `agent-blocked`) now produces an admitted delivery, which the router then drops on a map lookup.

Opening the filter removed the *structural* reason a label loop was impossible, so what replaces it has to be said out loud. **Four independent guards** stand behind the hole, and a loop needs all four to fail:

1. the router routes **only** the configured `autonomy.stages.*.enter` labels, so the harness's own stage writes die at the map lookup;
2. the **dispatch-time stage advance** removes the entry label before the run starts, so a backstop sweep querying `label:ready-for-agent` structurally cannot re-pick a dispatched issue;
3. **`hasRunForTrigger(triggerId, "build")`** — a fact in our own database that survives a failed label write. This is the real lock; guards 1–2 are why it is rarely the one doing the work;
4. **budget ceilings** (`autonomy.budget`) bound the blast radius if the first three somehow all fail: a harness-wide concurrency cap, a per-repo builds-per-day quota counting every status, and two daily spend ceilings — all enforced at the dispatch gate, with every refusal recorded (see [Router](/spec/05-router)).

And the hole is **narrow**. Bot-sent `issues.opened` and `comment.created` still drop on the filter, so the bot still cannot reply to itself — the failure mode the strict filter was written for.

### Which event a settle becomes

A `check_suite.completed` delivery carries a conclusion of its own, and it is
**not** what picks the event. The suite's colour says only which
check-reporting app happened to finish last; the decision reads the
**aggregate** state of the head SHA. So one `completed` branch resolves all
three outcomes, in this order:

| Aggregate | Population | Event |
|---|---|---|
| `failing` | dependency PR, or a head **we** pushed | `pr.checks_failed` |
| `passing` | dependency PR | `pr.checks_passed` |
| `failing` or `passing` | anything left, under `after-checks` | `pr.checks_settled` |
| `pending` / `none` | — | nothing (CI is still moving) |

The order is **fix outranks review** (09 → S2): `normalize()` returns one
envelope per delivery, so the precedence is the shape of the pipeline rather
than a policy bolted on later. Deliveries with a `cancelled` / `neutral` /
`skipped` / `stale` conclusion are dropped without an aggregate read at all —
nothing happened, and the round trip would buy nothing.

Reading the delivering suite's colour instead was a live deadlock
(nearform/skillspro#1646). The red and green cases were separate branches, each
with its own aggregate test, and the green one demanded `passing`. A PR with one
failing job whose *sibling* suite finished green afterwards landed in the green
branch, computed `failing`, and was dropped — while the failing suite, which the
red branch would have taken, had completed while the sibling was still running
and read `pending`. No event ever fired; under `review.postsCheck` the `queued`
placeholder sat on the PR until it was merged hours later. Nothing about the PR
was unusual: the outcome depended purely on the order CI settled in.

### Fork PRs and the check payloads

GitHub populates `check_suite.pull_requests[]` / `check_run.pull_requests[]`
**only when the head branch lives on the base repo**. A PR opened from a fork
carries an empty array, so every route keyed on it — the settle emit and both
Re-run buttons — used to drop the delivery outright.

That was invisible until `after-checks` became the packaged default. Under
`eager` the review fires from `pr.opened`, a `pull_request` event that always
carries the PR object, so forks never touched the check path at all. Under
`after-checks` a fork PR defers on `pr.opened`, posts its `queued` placeholder,
and then no settle event can ever conclude it — the check sits there for the
life of the PR, and on a repo that made it required the PR is unmergeable
(nearform/lastlight#282).

So an empty array falls back to asking the **base** repo which open PR this
commit heads (`listPullRequestsAssociatedWithCommit`). The base repo is the one
the App is installed on, so this needs no access to the fork. Two filters make
it a safe substitute for the payload's own array: `head.sha` must equal the
commit (the endpoint also returns PRs that merely *contain* it), and the PR must
be **open**. Results are sorted ascending so the rare commit heading two open
PRs resolves deterministically.

The lookup is resolved **after** the "does anyone consume this?" test, so a
delivery no route wants still costs nothing, and a same-repo PR never reaches it
at all.

**The maintainer-approval gate comes for free.** GitHub withholds Actions runs on
a fork PR from a first-time contributor until a maintainer approves them. No
approval means no checks, which means the aggregate is `none` and never settles,
which means no review. Gating on "CI settled" inherits GitHub's own gate exactly,
with no permission logic on our side — and it is why reviewing fork PRs is safe
to do by default: the same human decision that lets fork code run in Actions is
the one that lets it reach the review sandbox.

### Superseded check re-runs

`checks.listForRef?filter=latest` de-dupes per check **suite**, not per check
**name**. Re-running a failed job creates a new suite, so its green result comes
back *alongside* the red attempt it replaced — and both keep coming back for the
life of the SHA. Every aggregate read therefore collapses the list to the most
recent run of each `(app, name)` before judging it, so a re-run that goes green
actually clears the failure. Without that collapse `some(conclusion ===
"failure")` pins the SHA at `failing` permanently and no re-run can ever move it
— the other half of #1646, and the reason its aggregate could no longer reach a
state any emit branch accepted.

Latest-wins is also what gates the merge: branch protection satisfies a required
check from its most recent run, so reading the SHA any other way puts the
harness at odds with the gate it exists to feed. Two *different* apps posting the
same check name are not collapsed (the key is `(app, name)`), and a run carrying
no name is passed through untouched — de-duping is an identity claim, and
keeping both can only ever report a SHA redder than it is.

The same collapse applies to `getCiFailureReport`, so the fix agent is never
handed a red job that has since been re-run green: discovery and the fix prompt
have to agree on what "red" means.

### Multi-installation GitHub Apps

A GitHub App is installed **per account**, and each installation has its own id.
A token is minted against exactly one of them
(`POST /app/installations/{id}/access_tokens`), so a token minted against the
wrong installation is rejected — GitHub answers `422 There is at least one
repository that does not exist or is not accessible to the parent installation`,
which reads like a repo problem and is not one.

One instance therefore serves **every account its App is installed on**, and the
account is resolved per call. `InstallationDirectory`
(`src/engine/github/installations.ts`) is the single owner→installation
authority. Two feeds:

- **Webhook payloads.** Every delivery carries `payload.installation.id`
  alongside the account login. Authoritative, free, recorded before any
  filtering.
- **`GET /app/installations`**, under an App JWT. Needed by the routes with no
  webhook behind them — boot discovery, the cron fan-out, CLI/API triggers.
  Concurrent misses share one request, and a negative is cached briefly, so a
  fan-out over N repos costs one call rather than N.

Three consumers resolve through it, and nothing else knows an installation id:

| Consumer | Resolves from |
|---|---|
| The per-run scoped token mint (`prepareRun`, `src/engine/agent-executor.ts`) | `githubAccess.owner` |
| `GitHubClient` — every harness-side comment, reaction, check run, `.lastlight/` fetch (`src/engine/github/github.ts`) | the `owner` argument every method already takes; one memoized Octokit per installation |
| The read-only chat GitHub tools (`src/engine/github/github-tools.ts`) | each tool's `owner` param; the two `search` tools read it from the query's `repo:` / `org:` / `user:` qualifier, since an installation token can only search its own account |

An owner with no usable installation — never installed, uninstalled, or
suspended — fails the phase immediately, with that sentence: no sandbox, no API
call. `GITHUB_APP_INSTALLATION_ID` is optional and
carries no account, so it is used only when the JWT lookup itself fails
(network, revoked PEM): a pre-existing single-installation deployment then
degrades to exactly its old behaviour. `GET /admin/api/managed-repos` reports
every installation plus `uninstalledOwners` — any `managedRepos` account with no
installation — so the condition is visible before it becomes a failed run.

Each installation carries an `htmlUrl` deep link to its GitHub settings page
(where the repo grant, suspension and uninstall live), built server-side by
`installationSettingsUrl()` because **the path shape depends on the account
type** and guessing wrong 404s: an org install is
`/organizations/<login>/settings/installations/<id>`, a personal one a
viewer-scoped `/settings/installations/<id>`. It is `null` when the type isn't
known yet — a record seeded from a webhook that carried no `account.type` — so a
caller renders plain text rather than a link that may not resolve. The response
also carries `appInstallUrl`, the App's own install page, derived from `botName`
(which **is** the App slug), so an `uninstalledOwners` warning can offer the fix
rather than just naming the problem.

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

### App permission: `Commit statuses: read` (optional, recommended)

The same shape again, one API over: `Checks: read` gets the harness **check runs**. It does *not* get it the **classic commit statuses** a repo's CI may post instead (CircleCI, Jenkins, anything using the legacy statuses API). GitHub exposes the two as separate permissions over separate endpoints, and neither implies the other.

`GitHubClient.getChecksSummary` reads both, because the settle-aware verdict is meant to cover a repo whose CI reports *only* via statuses — exactly the population the live `check_suite` webhook never sees. The status leg is `repos.getCombinedStatusForRef`, which needs `Commit statuses: read`.

**The additive half must not be able to fail the whole read** (issue #277). The two calls were a `Promise.all`, which rejects on the first rejection — so an App holding `checks` but not `statuses` 403'd on the status leg and discarded the check-runs result *it was permitted to read*, losing its entire CI signal rather than the legacy half of it. Nothing surfaced it: `statuses` is requested by no scoped-token profile, so the token still mints (no 422) and the 403 arrives at call time; the run then completes and records `success = true` while every CI gate reads blind. It is now a `Promise.allSettled` — a rejected check-runs leg still throws, a rejected status leg degrades to "no status contexts", and the ref is judged on check runs alone.

That degradation is stated rather than inferred, and stated **once per owner per process**: the grant is per installation and the read runs on every `pr.synchronize` and every check settle, so a line per call buries the finding in tens of identical warnings a day.

### App permission: organization `Members: read` (optional, opt-in)

Required by, and only by, **per-repo dashboard visibility** (`teamVisibility`,
issue #169). With it, `GitHubClient.listUserTeams` can run one
`Organization.teams(userLogins:)` GraphQL query to learn which teams a
logged-in admin belongs to, and `listTeamRepos` can read those teams' repo
grants — so the dashboard shows that person their repos rather than the org's.

Deliberately optional and **off in config**: an existing installation that never
re-consents keeps today's behaviour exactly, because a denied query resolves to
the fail-open sentinel and nothing is filtered. Turning `teamVisibility.enabled`
on without the permission is harmless, just pointless. The matching webhook
subscriptions (`team`, `membership`, `organization`) are what keep the cache
current; without them the cache still expires on its TTL and
`POST /admin/api/me/repos/resync` still works.

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
| **Event types** | `message` only. All Slack inbound traffic — DMs (`message.im`) and `app_mention` in channels — normalizes to this one type. `reaction_added` / `reaction_removed` are the one exception: they are handled **beside** the envelope pipeline, not through it (see Feedback below). |
| **Filtered out** | Bot messages and non-text subtypes (edits, deletes); every inbound is logged (`[slack] inbound msg …`) *before* filtering so drops are diagnosable. Channel messages that aren't mentions or thread replies. |
| **Reply** | `reply(msg)` calls `sendMessage(channelId, threadId, chunk)` per chunk; long messages are chunked to respect Slack's ~3000-char limit. Replies post into the originating thread when one exists. Markdown is converted to Slack mrkdwn (`src/connectors/slack/mrkdwn.ts`): GFM tables render as aligned monospace code blocks (per-column width cap + total-width budget, with a `*label*: value` fallback for wide 2-column tables), since Slack mrkdwn has no table syntax. Markdown **images** (`![alt](url)`) are auto-promoted to Block Kit `image` blocks (`markdownToSlackBlocks`) — the mrkdwn path can only downgrade them to links — with a plain-text fallback if Slack rejects the blocks (e.g. an unreachable URL). |
| **Progress** | Workflow progress renders as a Block Kit checklist (a `header` + `context` meta + `divider` + sectioned steps with per-status emoji, via `renderProgressBlocks`) edited in place through `chat.update`, with the rendered markdown kept as the `text:` notification/accessibility fallback. The GitHub transport consumes the same `ProgressModel` as markdown — one content source, two renderings (`src/notify/`). |
| **Interactivity** | Approval gates post Approve/Reject buttons (Block Kit `actions`, `renderApprovalBlocks`). Slack POSTs a click to `POST /webhooks/slack/interactions` (signature-verified like events; deduped by `trigger_id`); it routes into the same `approval-response` resolution as the `/approve` slash command / `@last-light approve` comment, and the prompt message is rewritten to a button-free resolved state. `onApprovalAction` is wired in `src/index.ts`; socket mode uses Bolt `action` listeners. |
| **Feedback** | Emoji reactions on messages the bot posted become scored eval signals (issue #255). Requires the `reactions:read` bot scope + the `reaction_added` / `reaction_removed` subscriptions — **re-consent the app after adding them**, and until then Slack simply never delivers and the feature is dormant. `onReactionAction` is wired in `src/index.ts`; webhook mode routes through `dispatchSlackEvent`, socket mode registers Bolt `event` listeners, exactly as messages and mentions do. Attribution comes from an **anchor** recorded when we post: `SlackConnector.sendMessage` returns the message `ts` and every send site used to discard it, so each is now registered against the run (or chat session) that produced it. The alternative — resolving the thread at reaction time via `conversations.replies` — costs an API call per reaction, needs a `channels:history`-class scope we deliberately don't hold, and could only ever identify the *thread*, so a thread containing several runs could not say which one was being praised. The `SLACK_ALLOWED_USERS` allowlist is applied here too: a reaction handler is a second door into the same instance. (`src/engine/feedback/slack.ts`) |

| **Transcript** | The connector builds the session and stops there — it records no conversation (that double-wrote every chat turn). The thread's transcript is written one layer up, by `ChatRunner` for chat turns and by `src/connectors/messaging/thread-transcript.ts` for every other messaging path, so a workflow-answered turn is still visible to the next chat turn in the same thread. See [Chat](/spec/11-chat#the-thread-transcript--chat-is-not-the-only-writer). |

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
| **Job source** | `workflows/cron-*.yaml` files. `getJobs({ webhooksEnabled, db, crons, handlers })` (`src/cron/jobs.ts`) loads them, applies DB overrides from `cron_overrides` **and** the operator's `crons.disable` list, and filters those marked `condition: { unless: webhooksEnabled }` when webhooks are active. A cron turned off by either lever stays **registered**, carrying `_cronGloballyEnabled: false` — see "Per-repo cron participation" below. |
| **Two kinds of cron** | A definition declares **exactly one** of `workflow:` (dispatch an agent workflow — the normal case) or `handler:` (run host-side code from the registry in `src/cron/handlers.ts`). `handler:` exists for periodic work that is structurally un-agentable: the repo digest's facts live in the harness's own state database, which a sandboxed phase cannot reach, and it posts to Slack, which no agent has a tool for. Such a cron *could* use `registerDirect` (next row) — but a direct job is invisible to `getCronWorkflows()`, so it gets no dashboard toggle, no `cron_overrides` schedule, no per-repo participation and no "Run now". An unresolvable handler name **drops** the cron with a boot warning naming it (unlike an unknown `condition.unless`, which registers anyway); it cannot fail boot, because the registry is built from collaborators that may legitimately be absent. |
| **Every cron fire is ledgered** | A cron fire — scheduled or manual, `workflow:` or `handler:` — writes one `cron_runs` row keyed on the **cron's** name. Without it a fire that dispatches nothing is invisible: a handler cron has no `workflow_runs` row at all, and a discovery cron that finds nothing dispatches none, which is the normal steady state for a backstop behind a webhook. `withLedger` (`src/cron/handlers.ts`) wraps the handler registry and `makeCronRunner` (`src/cron/runner.ts`) wraps the workflow path; both write the same table, so `GET /crons` and the scheduler's consecutive-failure alert read one ledger and never branch on the kind of cron. Keying on the cron rather than the workflow is what makes the failure count sound — the same workflow is reachable from `/api/run`, a comment and Slack, and those runs must not move a cron's health (issues #341/#327). The wrap lives in the registry rather than the scheduler because the admin "Run now" route invokes handlers directly, and a manual fire that skipped the ledger would leave exactly that gap. For a *weekly* cron the difference is noticing a revoked Slack token on Monday instead of next month. |
| **Fan-out** | `dispatchCronWorkflow()` (`src/cron/fanout.ts`) fans out across a `repos` array in the context — **all at once, with no dispatch-side throttle**. Bounding concurrency is entirely the global admission cap's job (`concurrency.maxWorkflows`): each dispatch just creates a `workflow_runs` row, and an over-cap row is persisted `queued` and promoted as slots free. Each per-repo dispatch is its own workflow run with its own taskId. A cron whose context sets `discover: <key>` instead fans out **per subject**: the runner (`src/index.ts`) resolves the key against `CRON_DISCOVERERS`, finds the eligible subjects in code, and dispatches one bounded single-subject run each via `fanOutContexts`. Three discoverers find PRs (`src/cron/dependabot-discovery.ts`, `src/cron/review-discovery.ts`) and one finds **issues** (`src/cron/issue-discovery.ts`) — which is why the registry is `CRON_DISCOVERERS` rather than the `PR_DISCOVERERS` it once was, and why `CronCandidate` carries an optional `prNumber` *or* an `issueNumber` and the runner branches the context mapping on which is set. The PR discoverers' behaviour is unchanged by that widening. |
| **Direct jobs** | Two crons run a plain function instead of a workflow (`registerDirect`, no sandbox): `sandbox-sweep` (issue #106) and — only when `feedback.github` is on — `feedback-poll` (issue #255). The latter exists because **GitHub delivers no webhook for reactions**, so a 👍 on a bot comment can only be discovered by asking. It refreshes reactions for the least-recently-polled anchors through one batched GraphQL `nodes(ids:)` query per 100 — measured at **one rate-limit point per request**, reactors included — which is what makes polling affordable: a fixed-size working set (anchors retire after `feedback.windowDays`) costs single-digit points a tick against a 5,000/hour budget. `feedback.maxAnchorsPerTick / 100` is the hard request bound. (`src/cron/feedback-poll.ts`) |
| **Reply** | Cron jobs don't reply per se, and **a repo-scoped cron workflow has nowhere to reply to**: no issue and no thread, so `callbacks.postComment` is undefined and the agent's final output is recorded on the run only. A cron that wants to reach humans must either publish itself (`github_create_issue`, as `security-review` does) or be a `handler:` cron that posts directly — which is what `repo-digest` is. |

The dual webhook/poll model is intentional: with webhooks enabled, the
polling cron `cron-triage` silently de-registers — it is the only one carrying
`condition: { unless: webhooksEnabled }` — and with webhooks disabled it kicks in
to keep parity. The scheduled crons (`cron-health`, `cron-security`,
`cron-digest`) run regardless, and so do all four **backstop** sweeps
(`cron-review`, `cron-dependabot-merge`, `cron-dependabot-ci-fix` and
`cron-autonomy`): a backstop for a *missed* webhook has to run with webhooks on,
or it never covers the case it exists for. Each of those four says so in a
comment where its `condition:` would otherwise go.

### The repo digest

`cron-digest.yaml` (weekly, Monday 09:00) is the one cron that **posts to
Slack**. It is a `handler:` cron — `runRepoDigest` in `src/cron/repo-digest.ts`
— and its shape is deliberate:

- **The facts are computed in code**, from `GET /repos/{o}/{r}/issues?state=all&since=`
  (which returns issues and pull requests together, each PR carrying
  `pull_request.merged_at`) plus the harness's own `workflow_runs` and
  `executions`. So the numbers are arithmetic rather than a model's
  self-report, and a repo costs 3–4 GitHub requests.
- **`since` filters on `updated_at`**, so the response also contains items
  merely touched inside the window. Every count is taken from the item's own
  `created_at` / `closed_at` / `merged_at`, in `summarizeRepo`.
- **The week's CONTENT is a second, separate read** —
  `listRepoDigestDetail`, one GraphQL request carrying three aliased `search`
  queries (merged PRs, issues opened, issues closed) with each item's
  `bodyText`. It is `search` rather than the REST list because the REST list
  ranks by `updated_at`: fine for a count, wrong for a *list*, where a PR merged
  on Monday and untouched since would sort below any old issue commented on
  Friday. This read is **allowed to fail** (`fetchDetailSafely`) — a failure
  logs and drops the lists, and the digest posts the counts exactly as it did
  before the lists existed. That exemption matters because a failed repo fails
  the tick (below), and enrichment must not page anybody.
- **One optional model call** (`digest.narrative`) turns the week's items into
  two to four sentences of English. It is never asked to produce a number — the
  digest prints those underneath it — and a failure drops the summary rather
  than the digest. The prompt is composed by `buildSummaryPrompt` and budgeted
  in **characters, not items**: a single pull-request body can run to 11 KB, so
  `digest.detailItems` alone bounds nothing.
- **Each digest posts as a threaded pair** (issue #383). `renderDigest` returns
  `{ top, thread }`: the top-level message carries the repo header and the
  narrative summary; the threaded reply carries the content lists (Merged / New
  issues / Closed issues) and the Repo and Last Light stat sections. The poster
  in `index.ts` calls `sendMessage(channel, null, top.text, top.blocks, …)`,
  captures the returned `ts`, then calls
  `sendMessage(channel, ts, thread.text, thread.blocks, …)` to post the reply
  in the thread. The feedback anchor (issue #255) is registered on the
  **top-level** `ts` — that is what a channel reader sees and reacts to. If the
  first call returns no `ts` (the void path of `sendMessage`), the thread reply
  is posted unthreaded to the channel instead and a warning is logged; no
  content is dropped. Both calls pass `unfurl: false`.
- **`closingIssuesReferences` is a list of candidates, not of facts.** GitHub
  reports every issue *linked* to a merged PR — by keyword or through the
  Development sidebar — whether or not the merge closed it, and whether or not
  it is closed at all. `attributeClosures` therefore accepts a link only when
  the issue closed within `[merge − 5s, merge + 60s]`, because a merge closes
  its issues in the same operation (observed: +1s to +2s). Without that guard a
  digest tells three lies from one join: an issue closed by hand days earlier
  vanishes from "Closed issues", reappears under a PR that did not close it,
  and inflates the "closed by merged PRs" count. Cross-repo references are
  dropped outright — a foreign `#12` rendered against this repo's URL points at
  the wrong issue. The count of folded issues is taken from what was **actually
  removed** from the list, never from the number of references.
- **Bot pull requests are folded to a count.** A week of Dependabot bumps would
  otherwise fill the merged list and push the human work under the `…and N
  more` tail.
- **Every number is a link, and none of them unfurl.** `ref` emits a markdown
  link that `markdownToSlackMrkdwn` converts to Slack's `<url|#294>` form —
  markdown rather than that form directly, because the converter runs over these
  lines and would escape a pre-built one. Listed items render **GitHub's own
  `url`**, so issues resolve to `/issues/N` and pull requests to `/pull/N`; only
  the two lists with no URL of their own (the oldest unreviewed PR and the
  escalated ones, both from `listOpenPullRequests`) are built as `/pull/N`. The
  summary's own bare `#N` citations are linkified by `linkifyRefs` **only when
  the number is in the digest's fact set**, so a hallucinated reference reads as
  plain text instead of a confident link to somebody else's pull request. The
  post passes `unfurl: false`, which sets **both** `unfurl_links` and
  `unfurl_media` — without it Slack expands each citation into a preview card
  and buries the summary they annotate. It is opt-out per message
  rather than a connector-wide default: for a conversational reply one shared
  link and one useful preview is the right behaviour, and only a message whose
  links are a REFERENCE LIST wants them off.
- **Untrusted text is escaped before it is composed.** Issue titles, PR titles
  and the model's summary are all written by third parties and land in a channel
  unedited. Slack's control sequences are plain text — an issue titled
  `<!channel>` notifies everyone — so `escapeSlack` neutralizes `&`, `<` and `>`
  in every one of them *before* any link markdown is added. That ordering is
  what lets the two coexist: the only angle brackets reaching
  `markdownToSlackMrkdwn` are the ones the renderer put there.
- **The escalated-PR list is asked of GitHub** (open PRs labelled
  `requires-human`), not inferred from run rows — `fanOut` returns only
  `{dispatched, failures}` and a skip counts as a success, so an escalation is
  invisible in the cron's own reporting.

**It is inert until a channel resolves** (next section). No channel means no
post, no GitHub request and no model call — which is what keeps a fresh install
quiet.

**A failed repo fails the tick.** Each repo is attempted inside its own
`try`/`catch`, so one repo's bad day doesn't cost the others their digest — but
the tick then **throws** once the loop is done if any repo failed. Swallowing
them and returning normally would report success, and the failures that matter
here are not per-repo accidents: a revoked bot token, or the bot removed from
its channels, fails every repo at once, silently, once a week. Deliberately not
conditioned on "posted nothing": a repo with no channel is *skipped*, not
failed, so "considered 10, posted 0" stays the correct and quiet outcome for a
deployment that has configured nothing.

### Where a repo's Slack output goes

`resolveRepoChannel` (`src/notify/repo-channel.ts`), most specific first:

1. the repo's own `.lastlight/lastlight.yml` → `notifications.slack.channel`
2. the operator's `slack.repoChannels["owner/repo"]` (overlay `config.yaml`)
3. the global `slack.deliveryChannel` (`SLACK_DELIVERY_CHANNEL`)

and a fourth outcome that is **not** a fallback: nothing, meaning that repo gets
no digest.

A repo naming its own channel is safe without a clamp because of two facts that
are not about bounds: the repo layer is **always read from the default branch**,
never a PR head, so a pull request cannot redirect the bot's output; and Slack
will not deliver to a channel the bot has not been invited to. The operator's
kill switch is the generic one — drop `notifications` from
`repoConfig.allowKeys`.

`channel: null` committed by a repo means "send me nothing" and beats the
operator's map. That is why the resolver reads **provenance**
(`sources.notifications["slack.channel"] === "repo"`) rather than the merged
value: a merged `null` cannot say whether the repo chose it or simply said
nothing.

> **Removed:** `MessageDeliveryService` and `SlackConnector.sendToDeliveryChannel`.
> They were registered at boot and **never called from anywhere** — no call site
> in `src/`, none in git history — while four documents described
> `SLACK_DELIVERY_CHANNEL` as "the channel cron reports go to". The digest makes
> that sentence true; the dead wiring is gone rather than left as a second
> answer to one question.

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

A third additive sweep belongs to the software-factory pipeline rather than to
dependency PRs, and it discovers **issues**:

- `pick-up-ready-issues` (`workflows/cron-autonomy.yaml`, `discover:
  issues-ready-for-agent`, every 20 minutes) — finds the open issues sitting at
  an `autonomy.stages.*.enter` label and fans out one bounded single-issue run
  of that stage's workflow each, carrying `issueNumber`, the issue's current
  `labels` and the stage name: the same shape the `issue.labeled` webhook
  produces, reaching the same dispatch gate. It carries **no `condition:`**, and
  that is the whole point of it — it is the backstop for a *missed* webhook, and
  a dropped or undelivered `issues.labeled` delivery leaves an issue at
  `ready-for-agent` with nothing else ever re-checking. A sweep that only ran
  when webhooks were off would, by construction, never cover the case it exists
  for. Same reasoning as `check-prs-awaiting-review`.

  It filters on exactly three facts: the issue is open, it carries the stage's
  `enter` label, and it does **not** carry the stage's `running` label. That
  last exclusion is belt-and-braces for a real partial state: `advanceStage` is
  best-effort and never throws, so if the add of `running` succeeds and the
  remove of `enter` fails, the issue carries both labels — and a sweep querying
  only the entry label would re-pick an issue that is actively building,
  silently degrading guard 2 to guard 3. It costs nothing (the labels are
  already on the listing response) and keeps guard 2 structural through a
  partial advance. Per repo, candidates are keyed by issue number, so an issue
  carrying two stages' entry labels is offered **once**, at the first stage in
  config order; they are offered oldest-first and capped per repo per tick. An
  issue stranded at `running` after a crash is invisible to this sweep on
  purpose — a stalled build is exactly what a human should see, and the terminal
  observer moves failed runs to `on_failure` anyway; a stale-reaper would need
  its own attempt cap and its own cron.

  This is the shape of the 2026 spend loop (a cron that re-offers work already
  in flight), so it is worth saying what stops it: the stage label is advanced
  host-side **at dispatch, before the run starts**, so a dispatched issue
  structurally leaves the candidate set rather than being filtered out of it;
  `hasRunForTrigger` is checked at the gate regardless, so a failed label write
  still cannot re-spend; and the `autonomy.budget` ceilings bound the blast
  radius if both fail, with every refusal visible in the `cron_runs` ledger's
  `dispatched` count.

**The discoverers are candidate finders, not policy.** They answer one
question — does this subject *look* like it needs this workflow? — and nothing
else. Whether we may act on it (the hold label, the escalation guard, the attempt
counter, the cost cap, the per-SHA dedup, the fork guard, the run lock) is
decided once, off the resolved PR snapshot, at the `dispatchWorkflow` choke point
the webhook route crosses too: see the
[dispatch gate](/spec/05-router#the-pr-scoped-dispatch-gate). The issue sweep
splits the same way, against the [build dispatch
gate](/spec/05-router#the-build-dispatch-gate).

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
| **Per-repo visibility** | `GET /admin/api/me/repos` → `{ repos, synced, reason, teams, syncedAt }` — the managed repos this session's GitHub login should see, resolved from their org team grants (issue #169) and cached in the state database. `repos: null` is the fail-open sentinel meaning **no filter**, returned for a password/Slack session, `allowedOrg: "*"`, `teamVisibility.enabled: false`, an over-budget resolution, or any GitHub error. `POST /admin/api/me/repos/resync` forces a re-resolution **for the caller only** — there is deliberately no `?login=` override, because the response names the org teams a person belongs to (secret ones included) and an authenticated dashboard session is not the same standing as "entitled to enumerate org membership". The SPA applies the answer as `?repos=` on the run lists and as a local filter on sessions, with a header toggle to turn it off — **the list endpoints still return global data when the param is omitted**, so this is declutter, not access control. That toggle renders whenever `teamVisibility.enabled` is on, and carries the `resync` call in its unresolved state: the endpoint existed from the start but no UI ever invoked it, so a freshly-granted team was unreachable until the TTL lapsed. See [Configuration](/spec/02-configuration). |
| **PR retry** | `POST /admin/api/prs/:owner/:repo/:number/retry`, body `{ "reason"?: string }` — the third of the three surfaces that re-arm a pull request the harness escalated (see [Router](/spec/05-router#un-sticking-an-escalated-pr--the-three-retry-surfaces)). It is the only surface with no event of its own, so it resolves a `PrState` with `intervention: { via: "api", by: <session actor>, note: reason }`, crosses `applyPrDispatchGate` **itself**, and dispatches on `run` — the route that resolves is the route that gates. The workflow retried is the one that last worked the PR (`latestForTrigger` over the `pr_fix_shaped` family), else the configured `github.pr_fix` route. |
| **Pipeline board** | `GET /admin/api/board` — every open issue and pull request in the caller's scope, filed under the stage label it carries. Read-only, cached, and the only admin route that spends **GitHub** budget on a poll; see "The pipeline board" below. |
| **Stage move** | `POST /admin/api/issues/:owner/:repo/:number/stage` — write an issue's stage label (the board's drag gesture). Validates `to`/`from` against the CONFIGURED stage labels, re-reads the issue live, refuses a held subject, and writes through `advanceStage` (add-then-remove). It **never dispatches**; see "Moving a card writes a label" below. |

The retry endpoint's answers, in full: **200** on dispatch (`dispatched: true`)
or on record-without-dispatch (`dispatched: false, recorded: true`); **409** when
the hold label, the run lock or a degraded read refuses it (nothing recorded);
**403** for a repo outside `managedRepos`; **400** for a non-positive PR number;
**503** when `github` / `dispatchWorkflow` are not wired (chat-only, CLI-only);
**401** unauthenticated, from the same `authMiddleware` as every other admin
route. `lastlight pr retry <owner/repo#N> [reason]` is a thin client over it and
renders exactly those three outcomes (see `packages/cli/CLAUDE.md`).

### The pipeline board

`GET /admin/api/board` is the read side of the [software-factory pipeline](/spec/05-router#the-build-dispatch-gate): one screen showing where every open issue has got to, built out of the labels the gate writes rather than out of a table nobody maintains. It is read-only — nothing it returns mutates anything — and it is the only admin route whose cost is measured in GitHub requests rather than in SQL, which is what shapes the whole design.

**The rate limit is the reason the endpoint exists in this shape.** The naive version — poll each repo's issues over REST every 15 s — costs roughly 9,600 requests an hour for twenty repos, against the same 5,000/hour installation budget the harness spends reviewing pull requests. It would starve the product to draw a picture of it. Instead `GitHubClient.listOpenBoardItems` batches **one GraphQL document per owner installation, carrying up to ten aliased `search(type: ISSUE …)` blocks** — the idiom `listRepoDigestDetail` already uses — so twenty repos are two documents, not twenty requests. Behind that sit a **120 s TTL**, **single-flight per owner** (N dashboards refreshing at once cost one fetch, because the second caller awaits the first's in-flight promise) and **stale-while-revalidate** (a cached answer is served immediately and the refresh runs behind the request; only a repo with no last-good answer is waited on). The achieved budget for a twenty-repo board is **about sixty requests an hour, regardless of how many dashboards are open** — some 160× less than the naive design, and a function of the TTL and the repo count alone.

**GraphQL `search` is subject to GitHub's *secondary* limits**, which are not the documented point budget and arrive without warning as a 403 or 429. So a throttle degrades rather than fails: each repo in the batch falls back to a per-repo REST read (`listRepoActivitySince(..., { maxPages: 1 })`, open items only, labels with no colour), the repo is reported in `degraded` even though it has data, and the **owner** is put on exponential backoff — first window twice the TTL, capped at fifteen minutes — so a rate-limited board stops making things worse for the harness's own work. A repo whose fetch failed keeps its last good items and waits out the TTL before being retried, rather than re-requesting its owner's whole batch on every poll.

**Twenty repos, deliberately not two hundred.** `MAX_BOARD_REPOS = 20` is not `MAX_REPO_SCOPE = 200`: that cap bounds a WHERE clause, this one bounds live GitHub reads, and the two are three orders of magnitude apart in what they cost. Scope resolution narrows to the **autonomy allow-list** (`autonomy.repos`, intersected with the managed list) in precedence order — an explicit `?repos=` intersected with it, else the caller's team-visible repos, else every eligible repo ordered by activity — and an over-wide scope is **truncated, never refused**: the response carries `scope: { repos, truncated, reason }` so the UI can say "showing 20 of 57" instead of silently showing a subset. An empty `?repos=` intersection returns an empty scope with **200**, not 400.

**The board's universe is the autonomy allow-list, not the managed list.** This board is a view of ONE pipeline, and `autonomy.repos` is what decides which repos have one: a managed repo outside it has no stage labels anybody writes, no `build` the dispatch gate would admit, and every card action on it answers `409 not-autonomous` — because those actions cross the real gate, which checks exactly this list. Rendering it would show columns and menus for work that structurally cannot run, and pay a live GitHub read per repo to do it. The allow-list is intersected with the managed set rather than trusted outright, since the two are configured independently and a repo named in `autonomy.repos` the App cannot see is a typo, not a target.

The default branch is **every** eligible repo ordered by activity, not `distinctRepos()` filtered down to the eligible ones — those are different answers. A repo opted into `autonomy.repos` this morning has no runs yet, so the filtered form would hide it on the one day somebody most wants to watch it start; activity only ORDERS the list, and the tail is the rest of the allow-list, which is small by construction. With `autonomy.repos: []` — the shipped default — the scope is empty, the reason says so in those words, and **no GitHub read happens at all**, on the same argument as the `configured: false` return: a deployment that has not opted a repo in pays nothing for the tab existing. The stage columns still render, because an empty board with its stages visible says "nothing opted in" where no columns would say "nothing configured".

**Columns come from config, never from constants.** With no `autonomy.stages` configured the endpoint returns `configured: false`, **zero columns and zero GitHub reads** — a deployment that never opted into the pipeline pays nothing for the tab existing, and the UI says so rather than inventing an Intake / Triage / Review set nothing writes to. For each configured stage, four columns are derived from its label lifecycle in pipeline order (`enter`, `running`, `on_success`, `on_failure`), with a label two stages share collapsing onto its first column. `column.id` is `<stage>.<phase>` (`build.enter`) so it survives a rename; `column.label` is the raw GitHub label; `column.title` is *derived* from that label, so a renamed stage never renders a stale heading. A card carrying two stage labels is flagged `ambiguousStage: true`, and **the latest run decides which column it lands in**: a `succeeded` run means the `on_success` column, a `failed` or `cancelled` one means `on_failure`. The run is the fact; the labels are its projection. Column order alone gets this wrong in the case that actually happens — an issue that failed, was re-run and succeeded carries both terminal labels, and `on_failure` sits right-most, so the board would file a finished build under "blocked" and draw a green SUCCEEDED band inside a red column. With no run, or one still in flight, the **right-most** matching column wins: that is the partial advance `stage-advance.ts` documents (add succeeded, remove failed), and the card has progressed. The pair itself is prevented at the source too — the dispatch-time advance (guard 2) now clears the stage's terminal labels via `alsoRemove`, because a run STARTING means neither verdict holds any more, and nothing else ever cleared them: that advance removes `enter` and the terminal observer removes `running`. It is best-effort by contract, since a stale label is untidy rather than unsafe.

**A card carries a short excerpt of the item's body**, flattened and clipped to 280 characters by `boardExcerpt` in the GitHub client — GitHub's `bodyText`, so it is prose rather than a slice of `<details>` scaffolding, and the same field the weekly digest reads. Clipped on the SERVER rather than by the card, because the cost being controlled is the payload: twenty repos times fifty items times an essay-length issue body is a response whose whole design is "small enough to serve from cache every twenty seconds". A clipped excerpt ends in an ellipsis, so the card never has to guess whether it is seeing all of it. The throttled REST fallback carries **no** body — it exists because GitHub just refused us, and paying more requests for an excerpt would be the wrong trade.

**Moving a card writes a label — and, on the two build columns, starts a build.** `POST /admin/api/issues/:owner/:repo/:number/stage` is the board's drag gesture: it validates `to` and `from` against the labels the operator actually configured — a browser must never be able to write an arbitrary label to a repo through this route — re-reads the issue live rather than trusting a snapshot up to 120 s stale, refuses a subject carrying the hold label with the same sentence the bot would have posted, and then goes through `advanceStage` so the add-then-remove ordering is the one that module already argues for. A failed add is a 502 with nothing changed; a failed *remove* is a 200, because the issue carrying both labels is the tolerable half of that asymmetry. `to: ""` means "unstage" and is the one direct `removeLabel` call, safe precisely because a bare removal has no ordering to get wrong.

It **dispatches** when the card lands on a stage's `enter` or `running` column, crossing `applyBuildDispatchGate` with `route: "api"` and `senderIsBot: false` — a browser session is a human by construction, so the drag is the same instruction as the Dispatch button in a different gesture. The two terminal columns and `to: ""` move the card and start nothing: "done" is not a request to build, and `on_failure` doubles as the budget-exhausted comment's de-dup key. A 200 therefore answers two independent questions — `moved`/`advanced`/`removed` are the LABEL outcome, `dispatched`/`dispatchReason` the BUILD one — so a move that succeeds while the gate refuses (a budget ceiling, a run already in flight) is an ordinary 200 carrying the reason for the card to render.

**The bot skip is not relaxed, and the distinction matters.** `resolveBuildTrigger`'s `already-built` branch still hard-skips a BOT re-label — that is what stops label ping-pong, and the harness's own stage writes must never re-trigger the pipeline. What changed is that this route no longer *relies* on the webhook chain to start a build. Previously it did, and the cost was invisible from the UI: our own label write arrives with `senderIsBot: true`, so re-dragging an already-built issue — every guardrails failure, every `agent-blocked` card — wrote the label and started nothing at all, with nothing on the card saying why.

**The order differs by column, because only `enter` races.** `stageForLabel` matches only a stage's `enter` label, so only that write echoes back as a dispatchable webhook. Writing it and then dispatching opens a window between `addLabels` and `createRun` in which the echo arrives, reads `alreadyBuilt: false` and `runInFlight: false` — the bot skip never applies — and dispatches a second time; `simple.ts` then reuses the run row, since it dedups only a QUEUED one, and that is two agents in one workspace on one branch. So on the entry column the gate is crossed FIRST: on a dispatch verdict guard 2 has already advanced the issue to `running`, no `enter` label is ever written, no echo is emitted, and there is exactly one gate crossing per gesture — closed structurally, with no lock and no new state. The card lands in the running column and `landedLabel` says so. On a skip verdict the label is written as dragged. The `running` column keeps the simpler write-then-gate order because it has no echo; dispatching there is not a convenience, since the backstop sweep excludes the running label by design and a card dropped there with no run behind it would otherwise strand permanently.

**Three queries, whatever the card count — and a fourth only when a card has failed.** The cached GitHub batch, one `latestForTriggers` over every card's `owner/repo#N` trigger id (see [State](/spec/10-state)), and one `listPending()` indexed by run id. The fourth is `failureReasonsForRuns`, batched over the FAILED runs only, because `workflow_runs` has no error column and a FAILED band with no reason cannot distinguish "blocked by guardrails" from "crashed" — which on the bootstrap path is the whole question. It is skipped entirely on a board with nothing failing, and like the others it is O(1) in cards, which is what the claim is really about.

**`GET /admin/api/board/stream` pushes a CHANGE SIGNAL, never the board.** The board is otherwise a 20 s browser poll in front of a 120 s cache, so a label applied on github.com could take ~140 s to appear. The stream closes that: a revision string is recomputed every 3 s for the whole process and written only when it moves, and the client refetches `/board` at its own scope when it does. Pushing the rendered board instead would be wrong twice over — `/board` narrows per caller (`?repos=`, and per-actor team visibility), so the server would re-run that resolution for every connected client on every tick; and the frame would have to carry repo names, which is a side channel around the very visibility boundary that resolution exists to hold. The revision folds three things: the cache's content revision (moved by `noteRendered`, on a real change only — **not** on invalidation, which is not a claim that anything changed), a terminal-run counter, and the live shape of every active run, since a run advancing a phase changes a card without touching either counter. It carries a heartbeat, which the session-list stream it is otherwise modelled on does not need: a board can sit unchanged for hours, so silence is its normal state and an idle proxy would close the connection. The client falls back to the 20 s poll whenever the stream is not live, and keeps a 120 s safety-net poll while it is, so a stream that dies quietly cannot strand the view. A per-card run lookup would be fifty statements to render one screen. The route records **no** activity row either: `recordActivityFor` is for user-initiated mutations, and a dashboard polling every twenty seconds would drown the audit stream.

**The server computes each card's `actions`**, with `enabled` and `disabledReason`, because it is the only side that knows the hold label, the run lock and the route map — a client-side re-derivation would be a second policy free to drift from the gate that decides. A hold outranks everything, exactly as it does at the dispatch gate; `open` stays enabled under a hold, because reading is not acting; and **dispatch is never offered on a pull request**, because the pipeline builds issues. **The client renders those actions live**: each one posts to the endpoint the server named, and a refusal comes back as a sentence the card shows rather than a silent no-op. Together with the drag gesture above, that makes the board a surface that MOVES work, not just one that reports on it. **`unblock` is the affordance for a card that has STOPPED** — one parked on the stage's `on_failure` label, or whose last run failed. It matters because nothing else will move that card again on its own: the backstop sweep queries the `enter` label, so a parked issue is deliberately not a candidate. It is distinct from `retry`, and the distinction is the point: `retry` RESUMES the same run from the phase that failed, on the same branch and workspace, while `unblock` starts AGAIN from the entry column. A guardrails block wants the second; a run that died on a flaky step wants the first. It is not its own endpoint — it posts the **same** stage move the drag makes, carrying the target column in the action's `to`, so both gestures cross one gate and share one set of refusals. The server names `to` for the same reason it computes `enabled`: stage labels are operator-configured, and a client deriving "the entry column" from column order would be re-deriving policy it cannot see. The stale FAILED band clears itself, because the new run becomes the latest for that trigger. **A previous run does NOT disable `dispatch`**, and that is deliberate rather than an oversight. The gate treats a human ask as an explicit retry — `already-built` hard-skips a BOT re-label only, and this surface crosses with `senderIsBot: false` — so disabling on it made the board STRICTER than the server it speaks for, refusing something the endpoint would have honoured. It was also a dead end with no way out: a build that failed on the ENTRY column has no `unblock` (there is nowhere back to move it) and would have had no `dispatch` either, leaving only `retry` — which resumes the same failed run in its stale workspace, the one thing that cannot help when the blocker was fixed upstream. The action is labelled `Rebuild` rather than `Start build` once a run exists, so the card says which of the two it is offering.

**A card shows the phase its run is ACTUALLY in.** `workflow_runs.current_phase` cannot answer that: `persistPhase` is called on phase COMPLETION, and `createRun` seeds the column with `phases[0]`, so the column is right during the first phase and then lags by exactly one — a run working on `executor` reads `architect`, and a run that died before finishing anything reads the bare `phase_0` seed. Correcting it in the engine would mean writing the column at phase start, which changes what `handleExistingRun` reads to pick a resume point, so the board answers from the ledger instead: an in-flight phase is simply the `executions` row with no `finished_at`, and a failed one is the row that failed. That is the fifth conditional query above. The raw column is still sent as `currentPhase`, untouched; `phase` is the corrected answer and is absent when the two agree. Auth is the same `authMiddleware` as every other admin route.

The freshest the board gets is a function of the TTL, and the highest-value lever on that is not a shorter TTL but `invalidateBoard(repo)` — exported for a later slice to wire to the `issue.labeled` webhook, so a human moving a card sees it move.

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
| Thread transcript (the non-chat writer) | `src/connectors/messaging/thread-transcript.ts` |
| Slack connector | `src/connectors/slack/connector.ts` |
| CLI client | `src/cli/cli.ts` |
| API endpoints (`/api/run`, `/api/build`) | `src/index.ts:481–557` |
| Cron scheduler | `src/cron/scheduler.ts` |
| Cron job loader | `src/cron/jobs.ts` |
| Cron fan-out | `src/cron/fanout.ts` |
| Admin routes (including approval/cron mutations) | `src/admin/routes.ts` |
| Per-repo dashboard visibility resolver (issue #169) | `src/engine/github/team-visibility.ts` |
| Pipeline board — the pure projection onto columns | `src/admin/board.ts` |
| Pipeline board — the per-owner GitHub batch, TTL, single-flight and backoff | `src/admin/board-cache.ts` |

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

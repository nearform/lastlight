# Jira Cloud connector + notifier

Status: proposed, not started. Tracking: https://github.com/nearform/lastlight/issues/501. Paths under `src/`, `config/` and `workflows/` are relative to `apps/server/`. Line numbers are from `main` at 25818b18.

> This replaces the earlier draft (`jira-front-door.md`). That draft mirrored every Jira ticket into a GitHub issue, and its text is still in the body of #501. This design makes the ticket itself the subject of the run, as a Slack thread already is.

## Summary

Jira becomes a **third front door, alongside GitHub issues and Slack**. Someone on a team that tracks work in Jira Cloud can start a workflow from a ticket: triage it, ask a question, or ask for a build. They can answer the run's questions and approval gates from the ticket, and follow progress there. All code work still happens in GitHub: branches, PRs, reviews and pr-fix are unchanged. GitHub issues and Slack keep working exactly as they do today.

A run started from Jira is keyed `jira:{site}:{KEY}`, the way a Slack run is keyed `slack:{team}:{channel}:{thread}`. **No GitHub issue is created.** The PR the build opens links back to the ticket, and the ticket gets remote links and status transitions as the PR moves.

## Decisions (locked)

1. **Jira Cloud only.** Data Center/Server is out of scope: its auth, webhook format and comment body format all differ.
2. **The ticket is the subject.** There is no mirrored GitHub issue and no `jira:KEY` label. The Jira handle lives in the run's `context` / `scratch`.
3. **Auth is an API token, and the webhook is an admin webhook.** A dedicated bot account uses basic auth with an API token, and the webhook is HMAC-signed. Admin webhooks don't expire, so **there is no renewal job**, no OAuth token store, and no new DB table.
4. **Config lives in env and the overlay.** Secrets go in host env, behaviour in the overlay `jira:` block. There is no admin UI.
5. **Opt-in triggers.** A trigger label on the ticket (default `lastlight`), or a comment that mentions the bot on a ticket in a mapped project.
6. **Identity fails closed.** An empty `allowedAccountIds` means *nobody* can trigger. Slack is deliberately the other way round: an empty `SLACK_ALLOWED_USERS` lets everyone in.
7. **The sandbox never gets Jira credentials.** The harness reads the ticket in (context enrichment) and writes results out (notifier, reply). This is the same split Slack uses.
8. **Jira is best effort.** A failed Jira API call is logged at `warn` and skipped. It never fails or stalls a run.

## Non-goals

- Jira Data Center / Server.
- OAuth 3LO, Forge or Connect apps. These could sit behind the same `JiraClient` later if a deployment can't get a site-admin webhook (see the Automation fallback in §2 first).
- Syncing Jira field edits back into a running workflow.
- More than one Jira site per instance in v1.
- Feedback reactions (`feedback_anchors`) on Jira comments.
- Posting to Jira from runs that GitHub or Slack started. A ticket only hears about runs it started, or about PRs that carry its key (§8).

## Where the seams are

What exists today, and what this design leans on:

- **Inbound.**
  - The `Connector` / `EventEnvelope` contract (`src/connectors/types.ts:8-131`) and `ConnectorRegistry` (`src/connectors/index.ts`) need no changes to take a new connector.
  - The Slack connector shows how to mount a signed webhook on the shared Hono app (`src/connectors/slack/connector.ts`).
- **Thread-scoped runs already exist.**
  - A `slack:` trigger id waives the "needs an issue" requirement in `dispatchWorkflow` (`src/index.ts:467`, `:476-485`).
  - The thread handle is persisted on `context` (`index.ts:829-834`).
  - `slackPost` takes the place of the GitHub comment poster (`index.ts:1077`).
  - Pending reply gates are found by trigger id (`router.ts:1029`).

  Jira follows the same pattern.
- **Outbound.**
  - `NotifierTransport` (`src/notify/types.ts:48-77`) has `publish`, which edits one status surface in place; `note`; and an optional `noteApproval`.
  - `GitHubTransport` and `SlackTransport` are the templates.
  - Transports are built in `src/index.ts:1129-1227`, and only the GitHub one is rebuilt on boot recovery (`src/workflows/resume.ts:400-478`).
  - Handles persist in `NotifierState` under `workflow_runs.scratch.notifier`.
- **What breaks without an issue number** (this is the real work, §6):
  - Slack builds today *need* a real GitHub issue: `dispatcher.ts:453` takes the build path only when `issueNumber` and `repo` are both set.
  - `pr.md` renders `Closes #{{issueNumber}}`, which comes out as `Closes #0`.
  - Branch naming falls back to `lastlight/<workflow>` (`src/workflows/simple.ts:807`).
  - Context enrichment only runs when there is an issue number (`index.ts:1023-1070`).
  - Approval resume rebuilds `owner/repo#N` and silently *doesn't resume* otherwise (`dispatcher.ts:1140-1159`).
- **The word `"message"` means Slack.**
  - The dispatcher treats `type === "message"` as Slack in about nine places (`dispatcher.ts:306, 353, 465, 876, 888, 912, 1081, 1183, 1254`).
  - `MessageBatcher` batches every `"message"` envelope (`index.ts:2051`).

  Jira therefore gets its own event types rather than reusing `"message"`.

## Design

### 1. Config and secrets

Host env (secrets; changing them needs a container recreate, not a restart):

| Var | Purpose |
|---|---|
| `JIRA_SITE_URL` | `https://acme.atlassian.net` |
| `JIRA_EMAIL` / `JIRA_API_TOKEN` | Basic auth for the bot account |
| `JIRA_WEBHOOK_SECRET` | HMAC secret for the webhook |

At boot the bot's own `accountId` is read once from `GET /rest/api/3/myself`. It is the loop guard: events the bot authored are dropped.

The overlay `jira:` block goes in `config/default.yaml` and the schema in `src/config/config.ts`. It is inert by default:

```yaml
jira:
  enabled: false
  triggerLabel: lastlight
  allowedAccountIds: []        # Jira accountIds allowed to trigger / comment / approve. EMPTY = nobody.
  projects: {}                 # PROJ: { repo: owner/repo, components: { Backend: owner/api } }
  transitions: {}              # target STATUS names, all optional:
                               #   started: "In Progress"   prOpened: "In Review"   merged: "Done"
  webhook:
    url: null                  # public URL of /webhooks/jira (defaults from the server's public URL)
    autoSync: false            # reconcile the webhook at boot (needs a site-admin token)
```

A ticket's repo is resolved in this order:

1. an explicit `owner/repo` in the comment (the classifier already extracts it for Slack);
2. the ticket's component, via `projects.PROJ.components`;
3. the project default, `projects.PROJ.repo`.

The repo must also pass the existing `requireManagedRepo` / `isManagedRepo` gate. A ticket in an unmapped project is logged and dropped.

`routes.jira` is a new route table next to `routes.github` / `routes.slack`. It is added to `RouteConfig`, `normalizeRoutes` and `defaultRouteConfig` (`config.ts:1930-1990`) and to `config/default.yaml:908`. The existing test that pins the YAML to the code covers it.

### 2. Webhook registration: an idempotent reconcile, with no renewal

This was expected to be the hard part. Choosing admin webhooks over OAuth makes most of it go away.

**Why we don't copy guidemode.** guidemode (`~/work/guidemode/apps/server`) uses OAuth 3LO *dynamic* webhooks:

- Webhooks are registered with `POST /rest/api/3/webhook` and **expire after 30 days**.
- A daily cron (`src/api/services/jira/webhook-maintenance.ts`, called from `src/scheduled.ts:237-256`) calls `PUT /rest/api/3/webhook/refresh` for webhooks within 7 days of expiry.
- This needs rotating refresh tokens held in a DB (`jira_installations`).
- Its failure modes are what we avoid:
  - a failed refresh only logs, so the webhook quietly lapses and a human must re-create it;
  - nothing locks the refresh, so concurrent refreshes race on a rotating token;
  - tokens start out stored in plaintext.

**What we do instead.** Admin webhooks (`/rest/webhooks/1.0/webhook`) don't expire and accept a `secret`. Jira signs each delivery with `X-Hub-Signature: sha256=<hmac>`. Registration becomes a desired-state reconcile from config:

- `lastlight jira webhook sync` is a host-local CLI command, like the `server` commands. Optionally it also runs at boot when `jira.webhook.autoSync: true`. It:
  1. computes the desired webhook:
     - name `lastlight:<instance>`;
     - url `jira.webhook.url`;
     - events `jira:issue_created`, `jira:issue_updated`, `comment_created`;
     - JQL `project in (<mapped keys>)`;
  2. lists the existing webhooks and matches ours by name and url;
  3. creates, updates (events, JQL, url) or deletes duplicates to match;
  4. prints the diff it applied.

  Running it twice gives one webhook. Running it again after adding a project updates the JQL.
- `lastlight jira webhook status` reports drift without changing anything: missing, extra, or stale events/JQL.
- The JQL is deliberately *not* filtered on the trigger label. Comment-driven runs must work on tickets that don't carry it, and the connector filters cheaply anyway.

**Fallback when nobody has site admin:** a Jira Automation rule ("When: issue created/updated/commented → Send web request") posting to the same endpoint with an `X-Lastlight-Secret` header. A project admin can set this up. The connector accepts either form of authentication. The www setup page documents both.

**To verify against a live site before building:**

- Whether the admin-webhook REST API accepts `secret` (the UI does). If it doesn't, `sync` prints the one manual step needed to set the secret in the UI.
- Whether `comment_created` payloads carry enough issue fields (key, project, labels) to filter without a follow-up `GET`.

**Reusable from guidemode** (copy and adapt, not a dependency):

- the plain-`fetch` webhook CRUD in `src/api/jira-client.ts`;
- the 429 / `Retry-After` handling in `jiraFetch` (`src/api/services/jira/issues/api.ts:130-185`);
- the ADF→text helpers (`src/api/services/jira/issues/transform.ts:181-219`);
- the reconcile-and-report-orphans approach (`src/api/services/jira/webhook-registrations.ts`).

Its OAuth, tenant, permission and DB layers are not reused.

### 3. Jira client: `src/engine/jira/`

- `client.ts`: `JiraClient` over REST v3, using basic auth and 429 backoff. Methods:
  - `myself`;
  - `getIssue(key)`: summary, description, labels, components, status, and comments;
  - `addComment`, `updateComment`;
  - `getTransitions`, `transition`;
  - `addRemoteLink` (pass a `globalId` so repeat calls upsert);
  - `addLabels`;
  - `listWebhooks`, `createWebhook`, `updateWebhook`, `deleteWebhooks`.
- `adf.ts`: v3 comment bodies must be ADF, not markdown.
  - ADF→markdown, for the ticket body and comments going into the agent's context.
  - A small markdown→ADF converter, for `note()` / `reply()` text. It covers paragraphs, headings, bullet and numbered lists, links, bold and italic, inline code, and code blocks.
  - The status checklist renders **straight from `ProgressModel`**, the same way the Slack transport renders Block Kit. It does not go through markdown.
- It logs through `logger("jira")` and never uses `console.*`.

### 4. Inbound connector: `src/connectors/jira/connector.ts`

`JiraWebhookConnector` mounts `POST /webhooks/jira` on the shared HTTP app. It is wired in `src/index.ts` next to the Slack mount and only when `jira.enabled` is true.

Gates, in order:

1. Verify `X-Hub-Signature` (or the Automation header) over the raw body. A missing or bad signature gets a 401.
2. Dedup on `X-Atlassian-Webhook-Identifier`, using a bounded in-memory LRU.
3. Drop events from the bot's own `accountId`, from accounts not in `allowedAccountIds`, and from unmapped projects. Each drop gets one `info` log line.

Then the connector emits one of two event types:

- **`ticket.labeled`.** Emitted for `jira:issue_created` carrying the trigger label, or for `jira:issue_updated` whose `changelog` shows the trigger label being *added*. Removing the label does nothing.
- **`ticket.comment`.** Emitted for `comment_created` when either:
  - the comment mentions the bot (an ADF `mention` node with the bot's accountId, or a plain-text `@<botName>` prefix); or
  - the ticket has an active or paused run (a lookup by trigger id).

  Comments the bot posted itself are already dropped by the own-account gate.

The envelope:

- `source: "jira"`, with `repo` resolved per §1 and `issueNumber` unset;
- a new optional field `jira?: { site: string; key: string; url: string; commentId?: string; accountId: string }`;
- `title` set to the ticket summary, and `body` to the comment text (or the description, for `ticket.labeled`);
- `sender` set to the Jira display name, and `authorAssociation: "MEMBER"`, since the sender already passed the allowlist;
- `reply` posts a Jira comment.

`EventType` (`types.ts:78-124`) gains `ticket.labeled` and `ticket.comment`. Using new types instead of `"message"` keeps every Slack-specific `"message"` branch, and the batcher, from catching Jira events.

### 5. Router

Add a `jira` branch to the router modelled on the Slack one (`router.ts:1014-1391`):

- The trigger id is `jira:{site}:{KEY}`.
- **Pending gates are checked first, before classification.**
  - A pending reply gate is looked up with `getPendingReplyGateByTrigger(triggerId)`, as in `router.ts:1029`. A match routes the comment as the gate's answer.
  - Otherwise an `approve` / `reject` comment is looked up with `getPendingByTrigger(triggerId)` and routed to the approval handler **with the `workflowRunId`**.
- If no gate is pending:
  - `ticket.labeled` goes to `routes.jira.ticket_labeled`.
  - `ticket.comment` goes through `classifyComment` to build / answer / explore / approve / reject / chat, mapped through `routes.jira.*`.
- **Hold gate** (`router.ts:248`): extend it to Jira. A `hold` label on the *ticket* stops Jira-started work, just as the hold label on a GitHub issue does.
- **Disabled-workflow reply** (`dispatcher.ts:244`): Jira gets the reply, the same as Slack.
- **Ack reaction** (`dispatcher.ts:727`): this stays GitHub-only. Jira has no reactions API worth using.
- **Types and filters:**
  - `TriggerActorType` (`src/state/user-store.ts:11`) gains `"jira"`.
  - The dispatcher's actor-type branches (`dispatcher.ts:876, 888, 1183, 1254`) and `index.ts:819` learn about `jira`.
  - The admin source filter (`src/admin/routes.ts:1466`) accepts `jira`.

### 6. Runs without a GitHub issue number

This is the core engineering work. It also fixes Slack: a Slack-keyed run that hits an approval gate today records the approval and never resumes.

- **Subject.** `dispatchWorkflow` (`src/index.ts:467`) sets `context.subject = { kind: "github-issue" | "jira" | "slack-thread", ref, url, title }`.
  - A `jira:` trigger id waives the issue requirement the same way `slack:` does (`index.ts:476-485`).
  - The dispatcher's build path (`dispatcher.ts:453`) accepts `issueNumber` **or** a `jira` subject.
- **Context enrichment** (`index.ts:1023-1070`, `ENRICH_WORKFLOWS`). For a Jira subject:
  1. fetch the ticket description and comments;
  2. convert them from ADF to markdown;
  3. run the combined text through the same `screenForInjection`;
  4. fill `combinedContext`.

  The architect then sees the ticket as its spec, just as it would a GitHub issue body and thread.
- **Branch and task naming.** For a Jira subject, `simple.ts:807`, `workflowScopedTaskId` and `buildAssetIssueKey` key on the ticket: branch `lastlight/jira-proj-123`. The Jira key also goes in the PR title. Where the "GitHub for Jira" app is installed, Jira's development panel then links the branch and PR with no work from us.
- **Prompts.**
  - `workflows/prompts/pr.md:8-11` and `architect.md:41` swap `#{{issueNumber}}` for two new harness-rendered variables:
    - `{{subjectRef}}`: `#123`, or `PROJ-123`;
    - `{{subjectClosingLine}}`: `Closes #123`, or `Jira: [PROJ-123](<url>)` plus a `<!-- lastlight:jira PROJ-123 -->` marker that §8 reads.
  - Audit the other 13 prompts that use `{{issueNumber}}` (executor, fix, reviewer, re-reviewer, guardrails, verify*, qa-*, demo). `answer.md` and `explore-publish.md` already handle a missing number.
  - Each prompt either switches to `{{subjectRef}}` or is confirmed to degrade safely.
- **Phase ledger.** `issueNumberFromTrigger` (`packages/workflow-engine/src/core/phase-executor.ts:235`) matches `/#(\d+)$/` and returns `undefined` otherwise, so `jira:` triggers are already safe there. No change is needed.
- **Approval resume, generalised.**
  - `handleApprovalResponse` (`dispatcher.ts:1140-1159`) and the dashboard's `resumeWorkflow` (`index.ts:1727-1764`) stop rebuilding `owner/repo#N`. Both resume through the path `retryWorkflow` already uses (`resumeSimpleRun`, `index.ts:1800`), which rebuilds the full context from the run row.
  - The `!deps.github` early return (`dispatcher.ts:1130`) stays: the build still needs GitHub to push.
- **Reply gates.** `handleExploreReply` (`dispatcher.ts:1001-1087`) is hard-wired to re-dispatch `explore`. It should re-dispatch `run.workflowName`.
- **No state migration.**
  - `workflow_runs.trigger_id` is free text.
  - `owner` / `repo` are set from the mapped repo, and `issue_number` stays null.
  - The Jira handle lives in `context` and `scratch.notifier`.
  - Neither dialect changes.

### 7. Outbound: `src/notify/transports/jira.ts`

- `JiraTransport implements NotifierTransport`:
  - `publish(markdown, model)` creates one checklist comment on the first call and edits it in place after that;
  - `note()` posts a new comment;
  - `noteApproval()` posts the approval text: the `{{approvalUrl}}` dashboard link plus "comment `approve` or `reject`";
  - `terminalPing = false`, the same as GitHub.
- `NotifierState` (`types.ts:116-121`) gains `jiraKey` and `jiraCommentId`.
- **Wiring in `src/index.ts`:**
  - A `jiraChecklist` flag (subject is Jira and `status_checklist: true`) feeds `statusChecklist` next to `ghChecklist` / `slackChecklist` (`index.ts:1132-1133`).
  - A `jiraPost` replaces `callbacks.postComment` for Jira runs, mirroring `slackPost` (`index.ts:1077-1116`). Workflows without a checklist, such as `answer`, still reply on the ticket.
- **Boot recovery** (`src/workflows/resume.ts:400-478`): rebuild a `JiraTransport` from `scratch.notifier`, so a resumed run re-attaches to the same comment instead of posting a second checklist.

### 8. Ticket lifecycle: `src/engine/jira/sync.ts`

- **Run start.** A build on a Jira subject moves the ticket to `transitions.started`, and adds a remote link to the run's dashboard page.
- **PR lifecycle.**
  - `GitHubWebhookConnector` drops bot-authored PRs (`src/connectors/github-webhook.ts:369-372`), and every PR Last Light opens is bot-authored. So it gains an optional `onPullRequestLifecycle(payload)` callback that fires for `pull_request` `opened` / `closed` **before** that filter.
  - `JiraSync` finds the ticket from the `<!-- lastlight:jira KEY -->` marker in the PR body, or from the `lastlight/jira-…` branch prefix if the marker is missing.
  - **Opened:** add a remote link to the PR, and move the ticket to `transitions.prOpened`.
  - **Merged:** move the ticket to `transitions.merged`.
- **Transitions.** They are configured by *target status name*. `getTransitions` finds a transition from the ticket's current status to that name. If none exists, log at `warn` and skip.
- **What stays GitHub-only.** PR review, pr-fix and review comments stay on GitHub. Jira only hears about these milestones.

### 9. Docs (run the `docs-sync` skill)

- `apps/server/spec/`: the connector, notifier, router and config sections.
- `apps/server/CLAUDE.md`: add `connectors/jira` and `engine/jira` to the architecture tree, and the `JIRA_*` env vars.
- `packages/cli/CLAUDE.md`: `lastlight jira webhook sync|status`.
- A new `apps/www` page for Jira setup:
  1. Create the bot account and its API token.
  2. Set up the webhook: run `webhook sync`, or use the Automation fallback.
  3. Map projects (and optionally components) to repos.
  4. Fill the allowlist.
  5. Set the status names.

## Phasing (one PR each)

1. **Reply-only runs end to end.** Client, ADF, config, connector, router branch, the `webhook sync|status` CLI, and the `answer` / `explore` routes. These workflows already tolerate a missing issue number, plus `jiraPost` so replies land on the ticket.
2. **Runs without an issue number (§6).** Subject, enrichment, naming, prompts, and approval / reply resume through `resumeSimpleRun`. Then turn on `build` from Jira. Slack benefits from this phase too.
3. **Notifier and lifecycle.** The `JiraTransport` checklist, re-attach on resume, and §8.
4. **Jira triage.** `routes.jira.ticket_labeled` defaults to a triage variant whose agent returns a structured verdict. The harness applies that verdict as Jira labels and a comment, so the sandbox still gets no Jira credentials. Until this phase lands, `ticket_labeled` defaults to `answer`, which assesses the ticket and replies.
5. **Docs (§9).**

## Acceptance criteria

- [ ] A webhook with a missing or bad signature returns 401. A repeated delivery id is a no-op.
- [ ] Events from non-allowlisted accounts, from the bot's own account, and from unmapped projects are dropped with a log line. An empty allowlist triggers nothing.
- [ ] Adding the trigger label starts exactly one run keyed `jira:{site}:{KEY}`. Re-labelling while that run is active starts no second run.
- [ ] An allowlisted "@last-light what does X do?" comment is answered on the ticket.
- [ ] "@last-light build this" opens a PR in the mapped repo:
  - its branch is `lastlight/jira-…` and its title includes the key;
  - its body links the ticket;
  - no GitHub issue is created, and the text `Closes #0` appears nowhere.
- [ ] `approve` / `reject` comments on the ticket resume or fail the gated run. Approving from the dashboard also resumes it. A Slack-keyed gated run now resumes too.
- [ ] The checklist is **one** Jira comment, edited in place, and it survives a server restart mid-run.
- [ ] A build moves the ticket to `started`. Opening the PR adds a remote link and moves the ticket to `prOpened`. Merging moves it to `merged`. A missing transition is logged and skipped.
- [ ] A hold label on the ticket stops Jira-started work.
- [ ] Running `lastlight jira webhook sync` twice leaves exactly one webhook. After a project is added to config, it updates the JQL. `status` reports drift.
- [ ] A Jira outage never fails or stalls a run.
- [ ] `jira.enabled: false` (the default) mounts no route and makes no Jira API call.
- [ ] GitHub-issue and Slack flows behave exactly as before. The existing suites pass.

## Tests

Tests check mechanism, not prompt wording.

- **Connector:**
  - HMAC and Automation-header verification;
  - delivery-id dedup;
  - label *added* detection from the `changelog`;
  - own-account and allowlist gates;
  - repo-resolution precedence;
  - envelope shape for both event types.
- **Router:**
  - pending gates are checked before classification;
  - approve carries the `workflowRunId`;
  - the hold gate applies to Jira;
  - the disabled-workflow reply.
- **Dispatch and resume:**
  - the build path accepts a Jira subject;
  - approval resume through `resumeSimpleRun` for `jira:` and `slack:` triggers (a regression test for Slack);
  - the reply gate re-dispatches `run.workflowName`.
- **Prompt variables:** `subjectRef` / `subjectClosingLine` for each kind of subject.
- **`JiraTransport`:** create then update, and the handle persisting so resume re-attaches.
- **Webhook reconcile:** the computed diff for create, update, delete-duplicate and no-op, tested against a fake client.
- **ADF:**
  - snapshots for the checklist model;
  - markdown→ADF;
  - ADF→markdown, including mention nodes.
- **`JiraSync`:**
  - transition lookup by name, and a missing transition doing nothing;
  - finding the key from the marker and from the branch;
  - the lifecycle callback firing for bot-authored PRs.

## Manual verification

1. Run `pnpm dev` behind a tunnel, with a Jira Cloud test site and a scratch repo mapped to a test project.
2. Run `lastlight jira webhook sync` and confirm one webhook. Run it again and confirm it reports no change.
3. Walk the acceptance criteria:
   1. label → answer reply;
   2. "@last-light build this" → checklist comment and `In Progress`;
   3. approve from Jira → PR, `In Review` and a remote link;
   4. merge → `Done`;
   5. a non-allowlisted comment is ignored.
4. Restart the server mid-build and confirm the checklist comment is edited, not duplicated.
5. Release, deploy to drizby (the canary), and only then to nearform.

## Open questions

- Should closing the ticket in Jira cancel an active run? (Proposed: no in v1, just log it.)
- Should Jira priority or issue type feed triage? (Proposed: pass them into the triage context, nothing more.)
- How should the bot be mentioned: a real Jira user mention (an ADF mention node with the bot's accountId), a plain-text prefix, or both? (Proposed: accept both.)
- Is one Jira site per instance enough? (Proposed: yes for v1. The `site` is already in the trigger id, so more than one can come later.)

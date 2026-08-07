---
title: "State"
order: 10
description: "The SQLite tables for resume substrate and the per-session JSONL event log for agent transcripts. The split rule: what goes where, why, and how the dashboard reads both."
---

## Purpose

State is split deliberately between two stores:

- **SQLite** (`$STATE_DIR/lastlight.db`) — the resume substrate.
  Indexed, mutable, small. Tracks what's running, what's paused, what
  to do next.
- **JSONL** (per-session files under
  `$STATE_DIR/agent-sessions/projects/`) — the event log. Append-only,
  large, streamable. Captures every event the agent emitted, in order.

The split rule is load-bearing: unbounded text never lands in
`workflow_runs` blobs. Large LLM outputs live in JSONL or in
`executions.output_text` (a row the runner points at), never inlined
into the resume state read by every dashboard query.

## SQLite tables

`src/state/migrate.ts` defines eight tables (the per-table stores in
`src/state/*-store.ts` operate on them; `src/state/db.ts` wires the
stores together). All rows are append-only unless marked mutable.
Migrations are additive — `CREATE TABLE IF NOT EXISTS` plus
`ALTER TABLE ADD COLUMN` blocks wrapped in try/catch.

### `executions`

One row per phase execution (sandbox) or chat turn. The bridge between
the resume state and the JSONL.

```sql
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,           -- "webhook" | "cron" | "chat" | "api"
  trigger_id TEXT NOT NULL,             -- issue URL, Slack thread id, etc.
  skill TEXT NOT NULL,                  -- "workflow-name:phase-name" or "chat"
  repo TEXT,
  issue_number INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  success INTEGER,                      -- 1 | 0 | NULL (still running)
  error TEXT,
  turns INTEGER,
  duration_ms INTEGER,
  session_id TEXT,                      -- agentic-pi session id; key into JSONL filename
  cost_usd REAL,
  input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  output_tokens INTEGER,
  api_duration_ms INTEGER,
  stop_reason TEXT,
  workflow_run_id TEXT,                 -- → workflow_runs.id
  output_text TEXT,                     -- large final assistant text for loop iterations
  triggered_by TEXT,                    -- actor login/handle (joins users.login)
  trigger_actor_type TEXT               -- github | slack | cli | cron | admin | system
);

CREATE INDEX idx_executions_trigger      ON executions(trigger_type, trigger_id);
CREATE INDEX idx_executions_skill        ON executions(skill, started_at);
CREATE INDEX idx_executions_workflow_run ON executions(workflow_run_id, skill);
```

`output_text` is *only* populated when a loop iteration's
`scratch.<key>.lastOutputExecutionId` points at this row. The full
event stream lives in the JSONL; `output_text` is the cached final
assistant message the next iteration needs to read without rehydrating
the full conversation.

### `workflow_runs`

One row per workflow dispatch. The resume substrate.

```sql
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  owner TEXT,                                  -- GitHub org/user; composes owner/repo
  repo TEXT,                                   -- BARE repo name (path-safe segment)
  issue_number INTEGER,
  current_phase TEXT NOT NULL,
  phase_history TEXT NOT NULL DEFAULT '[]',   -- JSON array of completed phases
  status TEXT NOT NULL DEFAULT 'running',     -- queued | running | paused | succeeded | failed | cancelled
  context TEXT,                                -- immutable trigger context (JSON)
  scratch TEXT,                                -- mutable phase-to-phase state (JSON)
  node_statuses TEXT,                          -- DAG node status map (JSON)
  restart_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  triggered_by TEXT,                           -- ORIGINAL trigger's actor (joins users.login)
  trigger_actor_type TEXT                       -- github | slack | cli | cron | admin | system
);

CREATE INDEX idx_workflow_runs_trigger      ON workflow_runs(trigger_id, status);
CREATE INDEX idx_workflow_runs_status       ON workflow_runs(status);
CREATE INDEX idx_workflow_runs_started_at   ON workflow_runs(started_at DESC);
CREATE INDEX idx_workflow_runs_name_started ON workflow_runs(workflow_name, started_at DESC);
```

`scratch` is the only mutable JSON. `context` is set on creation and
never changed. `phase_history` is technically a JSON array that the
runner appends to. `restart_count` is the [Workflow Engine](/spec/06-workflow-engine)
crash-loop circuit breaker.

**Per-repository config on the row.** `context.models` / `context.variants` are
the run's **effective** maps — the target repo's `.lastlight/lastlight.yml`
already folded in (see [Configuration](/spec/02-configuration)). When a repo
layer applied, `context.repoConfig` additionally carries a `RepoConfigRunRecord`:
`repo`, `defaultBranch`, `treeSha`, `fetchedAt`, `applied` (only the leaves whose
provenance is `repo` — models / variants / approval / disabled, plus the clamped
leaves it won in the `fix` / `dependencies` / `review` policy blocks), `assets`,
and `warnings`. The policy leaves are recorded already clamped, so a resume
re-applies them over whatever the operator's block says *today*: a budget the
operator has since tightened still binds the resumed run, and one they have
loosened doesn't retroactively widen it. It is *persisted* rather than re-derived on read because the layer is
TTL-cached and mutable: by the time anyone asks why a run picked a model, the
repo's default branch may have moved on. **Resume reads this record instead of
re-resolving**, so an edit made while a run was paused/queued/dead can't
retarget it mid-flight. Asset-level drops discovered while running (a repo
`agent-context/*.md` ignored because a higher-trust layer owns that basename)
land on the mutable side, at `scratch.repoConfig.assetWarnings`; a resume that
could not restore the repo's unpacked asset tree records
`scratch.repoConfig.restoreWarnings`.

**The PR snapshot on the row.** For a PR-scoped workflow (`pr-fix`,
`dependabot-ci-fix`, `dependabot-pr-merge`, `pr-review`), `context.prState`
carries the whole `PrState` resolved at dispatch (see the
[dispatch gate](/spec/05-router#the-pr-scoped-dispatch-gate)) — verbatim, not
scattered leaves. Two reasons. **Forensics:** the run detail panel can show the
decision that was actually taken *and* the inputs that produced it, long after
the live state has moved on; a re-derivation at read time would answer a
different question. **The state machine reads it back:** the next dispatch for
that PR loads the previous run's snapshot to compute `attempt` (unchanged head,
or a head *we* authored, means the same problem and the counter advances;
anyone else's push resets it to 1), to carry `escalatedAtSha` and
`intervention` forward — which is what makes `requires-human` a notification
rather than a state, since a maintainer's push or a recorded retry clears the
guard with no label edit — and to answer "have we already assessed this exact
head SHA?". So the escalation record costs no new table, no extra API call and no
label mutation. Rows written before the snapshot existed are tolerated: a bare
`context.headSha` is honoured as a one-field snapshot, so the per-SHA dedup keeps
working across the upgrade instead of re-assessing every open PR once.

`intervention` is the newest of those folded fields and the only one recording
**human intent** rather than a fact about the pull request:
`{ at, atSha, via: "comment" | "label" | "api", by?, note? }` — the last time
somebody told us to try again (see
[Router](/spec/05-router#un-sticking-an-escalated-pr--the-three-retry-surfaces)).
It is re-sanitized on read as well as on write, exactly as `notes` is, so a row
written by an older build cannot carry a `note` past today's rejection rules; and
`by` / `note` are for display and for the journal only — no decision function
reads either. A retry that is folded forward and found to be *new* re-arms the
attempt counter and the cost baseline and clears `escalatedAtSha`; the record is
what makes that re-arm once-only, since the next dispatch reads the same
intervention back and does not re-arm again.

**The marker harvest on the row.** The snapshot is written at *dispatch*, before
any phase runs, so what the run then *concluded* cannot live there. For the fix
family, `RunnerCallbacks.onPhaseEnd` parses each phase's `DIAGNOSIS_COMPLETE` /
`CI_FIX_COMPLETE` marker and merges it into `scratch.fixMarkers` — the run's
mutable side — where the next dispatch reads it back off the same
`latestForTrigger` row to derive `attempt`, `flakyDeferrals` and
`priorAttempts` (see the
[dispatch gate](/spec/05-router#the-pr-scoped-dispatch-gate)). It rides the
existing row and the existing query: no new column, no second write path. The
harvest is wired at **all three** `onPhaseEnd` call sites (fresh dispatch plus
both resume paths), because a fix run that paused for an approval gate or was
picked back up after a restart finishes its phases on the resume path — exactly
the population whose attempt counter matters most. Presence of the
`fixMarkers` key, not of a marker inside it, is what distinguishes "the harvest
ran and the agent emitted nothing" from a row written before the harvest
existed; the latter falls back to the `diagnose` ledger row, which cannot exist
without the marker having been emitted.

**The journal rides the same hook.** The markers are the only thing an agent
can leave behind *in its output*; the **PR journal** is the only thing it can
leave behind by choosing to. It travels the workspace instead: the agent
appends one line per note to `.git/lastlight-notes` in the checkout, and the same
`onPhaseEnd` harvest drains the file — reading it and deleting it, so it is a
per-phase outbox rather than an accumulator — into `scratch.fixMarkers.notes`,
where the next dispatch folds it onto `PrState.notes`. One hook and one scratch
namespace on purpose: a second hook is a second thing to wire at three call
sites and a second thing to forget at the fourth. Unlike the markers the
journal is open to *every* PR-scoped workflow, gated on the run carrying a
`context.prState` (which is precisely what makes a run PR-scoped), so
`pr-review` reads what `dependabot-ci-fix` learned. The file lives inside the
**checkout's own `.git/`** on every backend, which git never walks, so it cannot
be committed into the target repo whatever the agent's `git add -A` does — see
[Sandbox](/spec/09-sandbox). Bounds, kinds, staleness and the trust rules are
in the [dispatch gate](/spec/05-router#the-pr-scoped-dispatch-gate).

**The push gate rides it too.** The fix loop's gate — `.git/lastlight-verify.sh`,
written by the agent for itself — is *read* by the same harvest onto
`scratch.fixMarkers.verifyScript` (bounded at 8 KiB, head kept), for the fix
family only. A read, not a drain: unlike the journal this file is the live gate
the next loop iteration runs, and removing it would disarm the loop the harvest
is reporting on. The last non-null reading stands, since the gate is reset once
per *attempt* rather than per phase. 09-state-machine.md §S1 calls this "the most
useful debugging artifact in the fix loop": the gate is the one input to a fix
run that nothing else records, the workspace is reset before the next attempt,
and the script's contents are deliberately never validated — recording it is
what lets a human see the problem instead of guessing at it. The admin run
detail panel renders it beside the snapshot. Inert on the kubernetes backend,
where the harness has no filesystem access to the PVC — the same narrowing the
journal carries there.

**The escalation row.** Almost every row here is created by
`runSimpleWorkflow` and describes a run that executed. One is not: when the
[dispatch gate](/spec/05-router#escalation--the-skips-that-are-not-silent)
refuses a PR *terminally* — attempts exhausted, cost budget exhausted, or a
last diagnosis outside `fix.retryableClasses` — it writes a row for the
refusal itself, under the workflow it declined to run, with no phases and
`context.escalation = { case, reason, at }` beside the snapshot. This is not
bookkeeping: `escalatedAtSha` is read back off the *prior run's*
`context.prState`, and a dispatch-time skip writes no row at all, so an
escalation that recorded nothing would never persist it — the `escalated:`
guard would never bind, and every subsequent event on the same dead PR would
escalate again, re-applying the label and posting the comment once per event.
The row is written **before** the label for the same reason (row-then-crash
leaves a record with no label, which is quiet; label-then-crash leaves a
`requires-human` nothing in the code can see), and is recorded **`succeeded`**:
`failed` is reserved for malfunction, and a correct-but-stopped outcome recorded
`failed` would post `messages.on_failure`, offer a Retry that cannot succeed, and
pollute the cost/failure stats.

**The retry row** (`current_phase = "retry-requested"`) is the second row of
that kind, and the mirror image of the first: it records a human's ask that
produced **no** run, so the ask is not lost when the gate then skips for an
unrelated reason (`upstream-broken` — the base is red at the moment somebody
asks). Same shape and same ordering as the escalation row, `succeeded`, with
`context.intervention` beside the snapshot, `trigger_actor_type = "system"`
(the harness recording a fact, not a person's run) and `triggered_by` set to
whoever asked. It is idempotent: `recordIntervention` refuses when the prior
PR-scoped row already carries the same intervention, which is what makes it safe
on a route that fires per cron tick. A retry that *does* dispatch needs no row —
the dispatched run's own `context.prState` carries the intervention.

This row is the one `succeeded` row that must **not** count toward the per-head
`already-assessed` dedup (`assessedHeadShaByWorkflow` skips it): it records a
dispatch that did not happen, and it carries the intervention forward, so
counting it would make the row written to *defer* an ask read as having served
it.

`owner` + `repo` together identify the target: `repo` is stored **bare**
(a single path-safe segment — taskIds and workspace/session dirs derive
from it), so the org/user is kept in its own `owner` column rather than
inside `context` alone. That lets the runs-list query (which omits the
heavy `context` blob) compose the qualified `owner/repo` for the Repos-tab
grouping and the dashboard's GitHub links. Added by an additive migration
that backfills existing rows from `context.owner`.

The `queued` status is the persisted form of the global concurrency cap
(see [Workflow Engine](/spec/06-workflow-engine)): when a fresh trigger
arrives while `countRunning() >= concurrency.maxWorkflows`, the run is
created `queued` instead of `running` (the column is untyped `TEXT`, so no
migration is needed). The admission controller promotes queued rows FIFO
via a compare-and-set (`admitRun`: `UPDATE … WHERE id = ? AND status =
'queued'`), so the event-driven and periodic-sweep admission paths can race
safely — only the first writer wins a row. Queued rows older than
`concurrency.maxQueueWaitMs` are transitioned to `cancelled` by the sweep.

**Boot recovery of queued runs.** A run left `queued` when the harness died
carries a stale `started_at` that the sweep would instantly TTL-reap. On boot,
`resumeOrphanedWorkflows` re-stamps each queued orphan's enqueue clock
(`requeue`, a CAS on `status = 'queued'`) so the admission controller promotes
it normally instead of dropping it. (`running` orphans are re-dispatched;
`paused` are left for the approval flow.)

**Retrying a stopped run.** `restartRun` (CAS on `status IN ('failed',
'cancelled')`) flips the row back to `running`, clears `finished_at` and the
`context.error` annotation, and re-dispatches via the ledger-driven resume path.
`cancelled` is retryable because it covers a queue-drop after a server death and
a manual cancel — both recoverable, neither a permanent verdict. Reached from
`lastlight workflow retry <id>` and the dashboard Retry button.

### `workflow_approvals`

```sql
CREATE TABLE IF NOT EXISTS workflow_approvals (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,        -- → workflow_runs.id
  gate TEXT NOT NULL,                   -- "post_architect", "post_reviewer", etc.
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  kind TEXT NOT NULL DEFAULT 'approve',   -- "approve" or "reply" (Socratic loop)
  artifact TEXT,                          -- handoff doc the gate is approving (e.g. architect-plan.md)
  requested_by TEXT,
  responded_by TEXT,
  response TEXT,
  responded_at TEXT,
  created_at TEXT NOT NULL
);
```

`kind: "reply"` is the Socratic loop's reply gate — any free-form
message resolves it; no explicit approve / reject needed.

`artifact` (nullable) names the handoff doc a gate is asking a human to
approve, set from a phase's `approval_artifact:` field. It powers the
**focused approval view** (`/admin/?approval=<id>`): `GET
/admin/api/approvals/:id` enriches the row with an `artifactRef` (owner /
repo / issueKey / doc, plus a GitHub blob URL in repo mode) so the view can
open the doc — editable in server mode, link-out in repo mode — beside the
approve / reject buttons. See `06-workflow-engine.md`.

`ApprovalStore.listForWorkflow(runId)` returns every approval for a run (all
statuses, oldest first), exposed as `GET /admin/api/workflow-runs/:id/approvals`.
It powers the run-detail pipeline's approval-gate nodes (status-colored, labeled
by gate) and their read-only history (who approved / rejected, when, and any
comment) — distinct from `GET /admin/api/approvals`, which lists only pending
gates across all runs.

### `cron_overrides`

```sql
CREATE TABLE IF NOT EXISTS cron_overrides (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  schedule TEXT,                        -- override the YAML schedule
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
```

Mutable. Deletion reverts to YAML defaults.

### `workflow_overrides`

```sql
CREATE TABLE IF NOT EXISTS workflow_overrides (
  name TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
```

Workflow-level kill switch. Absence of a row = enabled by default.

### `users`

First-class user identity, populated on every dashboard login (GitHub +
Slack OAuth). An **additive enrichment** table: every actor column elsewhere
(`workflow_runs.triggered_by`, `executions.triggered_by`,
`workflow_approvals.responded_by`, `cron_overrides.updated_by`) stays free-text
`login`, and this row is resolved by LEFT-JOIN on `login`. `github_id` /
`slack_user_id` are the stable upsert keys; `email` is captured as the future
outbound-email hook (nothing sends yet) and is **indexed but NOT unique**
(shared corporate mailboxes + many null Slack-only rows would collide a UNIQUE
constraint).

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                    -- randomUUID
  github_id INTEGER UNIQUE,               -- stable numeric id (upsert key); null for Slack-only rows
  login TEXT UNIQUE,                      -- GitHub login = the soft join key used everywhere
  name TEXT,
  email TEXT,                             -- future email hook; indexed, NOT unique
  avatar_url TEXT,
  slack_user_id TEXT UNIQUE,              -- U… id, linked lazily on Slack match
  is_blocked INTEGER NOT NULL DEFAULT 0,
  email_is_placeholder INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE INDEX idx_users_login ON users(login);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_slack ON users(slack_user_id);
```

The GitHub OAuth callback upserts on `github_id` (falling back to
`GET /user/emails` for the primary+verified address when the profile hides it);
the Slack OAuth callback and the Slack connector match a user's email to an
existing row and link `slack_user_id` onto it (else create a Slack-only row).
The verified GitHub `login` then rides the session HMAC token so actor-hardcoded
routes attribute an action to a real person. **Actor semantics:** a run's
`triggered_by` is the ORIGINAL trigger; retry / cancel / approve actors land on
the append-only `executions` ledger (and `workflow_approvals.responded_by`),
never overwriting the run's origin value. See `src/state/user-store.ts`.

### `messaging_sessions` + `messaging_messages`

```sql
CREATE TABLE IF NOT EXISTS messaging_sessions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,                -- "slack"
  channel_id TEXT NOT NULL,
  thread_id TEXT,
  user_id TEXT NOT NULL,
  agent_session_id TEXT,                 -- pi-ai session id → JSONL filename
  created_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  message_count INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1
);

CREATE INDEX idx_msg_sessions_lookup ON messaging_sessions(platform, channel_id, thread_id, user_id);
CREATE UNIQUE INDEX idx_msg_sessions_unique_active
  ON messaging_sessions(platform, channel_id, thread_id, user_id) WHERE active = 1;

CREATE TABLE IF NOT EXISTS messaging_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES messaging_sessions(id),
  role TEXT NOT NULL,                    -- "user" | "assistant"
  content TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  platform_message_id TEXT
);

CREATE INDEX idx_msg_messages_session ON messaging_messages(session_id, timestamp);
```

The partial unique index enforces "one active session per
(platform, channel, thread, user)" while allowing old inactive rows
to stack. See [Chat](/spec/11-chat) for the session lifecycle.

### `feedback_anchors` + `feedback_signals`

The eval-signal ledger (issue #255): a 👍/👎 somebody left on something the bot
wrote, scored against the workflow run that wrote it. Two tables, because a
reaction names a **message** and the signal needs a **run**.

```sql
CREATE TABLE IF NOT EXISTS feedback_anchors (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                  -- "slack" | "github"
  kind TEXT NOT NULL,                    -- slack_message | issue_comment | review_comment | issue
  external_id TEXT NOT NULL,             -- Slack ts, or the GitHub comment id as TEXT
  node_id TEXT,                          -- GraphQL global id (github; the batch key)
  channel TEXT NOT NULL DEFAULT '',      -- Slack channel; '' for github (see below)
  owner TEXT, repo TEXT, issue_number INTEGER,
  workflow_run_id TEXT,                  -- the attribution; NULL is legal
  workflow_name TEXT,
  messaging_session_id TEXT,             -- chat turns, which have no run
  created_at TEXT NOT NULL,              -- when the bot posted it
  last_polled_at TEXT,                   -- github only
  UNIQUE(source, channel, external_id)
);

CREATE TABLE IF NOT EXISTS feedback_signals (
  id TEXT PRIMARY KEY,
  anchor_id TEXT NOT NULL,
  source TEXT NOT NULL,
  workflow_run_id TEXT, workflow_name TEXT, messaging_session_id TEXT,
  owner TEXT, repo TEXT, issue_number INTEGER,
  emoji TEXT NOT NULL,                   -- canonical name (engine/feedback/reactions.ts)
  score INTEGER NOT NULL,                -- -2..+2; 0 = recorded, not scored (👀)
  sentiment TEXT NOT NULL,
  reactor TEXT, reacted_at TEXT, observed_at TEXT NOT NULL,
  removed_at TEXT,                       -- retraction, not deletion
  exported_at TEXT,                      -- OTel watermark
  UNIQUE(anchor_id, reactor, emoji)
);
```

An **anchor** is written when the bot posts (Slack, where the message ts is only
knowable in the `chat.postMessage` response) or when a run finishes (GitHub
discovery). Attribution is fixed at that moment and never recomputed — later
there is nothing left to attribute *from* but timestamps. The run columns are
denormalized onto `feedback_signals` for the same reason the rest of this page
avoids joins on hot paths: every analytics query then reads one table.

Two invariants the schema encodes:

- **`UNIQUE(anchor_id, reactor, emoji)` makes ingest idempotent.** Slack
  redelivers, and the GitHub poller re-reads the same reactions every tick;
  both must be replayable without inflating the count.
- **`channel` is `''`, never NULL, for a surface that has none.** SQLite treats
  NULLs as DISTINCT in a UNIQUE constraint, so a nullable channel makes
  `UNIQUE(source, channel, external_id)` — and the `ON CONFLICT` targeting it —
  silently inoperative for every GitHub anchor. The sentinel keeps one
  uniqueness rule and one upsert path for both surfaces; `FeedbackStore` maps
  it back to null at its boundary.
- **A retraction is a fact, not a delete.** `removed_at` is stamped and the row
  stays. Every scoring query filters `removed_at IS NULL`.
- **The export backlog excludes retracted signals.** A reaction added and then
  withdrawn while telemetry was off has no `exported_at` and a `removed_at`;
  `pendingExport` filters on both, so the drain can't put a score onto a trace
  that its author took back.
- **`exported_at` is only stamped when a span was actually emitted.** Marking a
  signal exported while telemetry was off would silently discard it — enabling
  OTel later would find an empty backlog and the whole pre-OTel history would be
  absent from the backend forever. `drainFeedbackExport` (called at boot) is
  what catches up, so the watermark has to mean what it says.

`workflow_runs` also carries `trace_id` / `span_id` for this feature — see the
next section.

### `github_teams` + `github_team_repos` + `github_team_members` + `github_visibility_sync`

The dashboard's per-repo visibility cache (issue #169): which managed repos a
GitHub-authenticated admin sees by default, derived from their org team grants.

```sql
CREATE TABLE IF NOT EXISTS github_teams (
  org TEXT NOT NULL, slug TEXT NOT NULL, name TEXT,
  repos_synced_at TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,   -- grant too large to enumerate
  PRIMARY KEY (org, slug)
);
CREATE TABLE IF NOT EXISTS github_team_repos (
  org TEXT NOT NULL, team_slug TEXT NOT NULL, repo TEXT NOT NULL,
  PRIMARY KEY (org, team_slug, repo)      -- repo = owner/repo, ∩ managed
);
CREATE TABLE IF NOT EXISTS github_team_members (
  org TEXT NOT NULL, team_slug TEXT NOT NULL, login TEXT NOT NULL,
  PRIMARY KEY (org, team_slug, login)
);
CREATE INDEX IF NOT EXISTS idx_github_team_members_login
  ON github_team_members(login);
CREATE TABLE IF NOT EXISTS github_visibility_sync (
  login TEXT PRIMARY KEY,
  synced_at TEXT NOT NULL,
  status TEXT NOT NULL,                   -- ok | empty | truncated | error | disabled
  detail TEXT
);
```

**This is a cache, not a mirror of the org.** Nothing is enumerated up front:
rows appear only for the teams of a person who actually logged in, resolved on
their first dashboard request and refreshed per `teamVisibility.ttlMinutes`. The
alternative — walk every managed repo, list the teams with a grant, pull each
team's members — is thousands of API requests in an org with thousands of repos,
almost all of it describing teams nobody using the dashboard belongs to. Safe to
delete wholesale; it refills.

Three invariants the schema encodes:

- **Absence means "unknown", never "no access".** `github_team_members` records
  membership we *learned* while resolving one login, not the team's roster. So
  every read path fails OPEN — a miss shows everything.
- **`truncated` forces its members open too.** When a team's grant exceeds
  `maxPagesPerTeam`, `github_team_repos` holds a *prefix*. A partial list is the
  one genuinely harmful answer: it hides repos the person is responsible for and
  looks exactly like the repo having no activity. So a truncated team makes the
  answer "no filter" rather than "these ones".
- **`github_visibility_sync` remembers failures, not just successes.** An
  over-budget or errored resolution is stored with its status and reused for the
  TTL, so a permission GitHub will keep refusing isn't re-attempted on every
  dashboard poll.

Kept current by `team` / `membership` / `organization` webhooks, which
**invalidate** (delete the affected rows) rather than re-derive — re-deriving on
a webhook would put an unbounded org walk on the delivery path. `POST
/admin/api/me/repos/resync` is the manual fallback where those events aren't
wired up.

### `workflow_runs.trace_id` / `span_id`

Written by the observability adapter in `src/workflows/runner.ts` when the
`lastlight.workflow.run` span opens. A feedback signal can arrive days after
that span closed, and these two columns are the only way to export it *onto the
trace it grades* rather than as a disconnected trace of its own. NULL whenever
telemetry was disabled during the run, in which case the signal exports as its
own root span.

`messaging_messages` is the **thread's** conversation, not chat's — a message
answered by a workflow is recorded here too, by `thread-transcript.ts` rather
than by `ChatRunner`, so the next chat turn in that thread can see it. Reads are
newest-N (`getHistory`), and the sessions table is addressable by thread alone
(`findActiveThreadSession`) for the writer that knows only the channel + thread.

## JSONL event log

Per-session, append-only, one file per agent session.

### Paths

```
$STATE_DIR/agent-sessions/projects/
├── -<sanitized-cwd>/<sessionId>.jsonl    ← sandboxed workflow phases
│   (e.g. -home-agent-workspace/<id>.jsonl)
└── -app/<sessionId>.jsonl                ← chat turns (cwd = /app)
```

Sanitization: slashes in the agent's cwd become dashes via
`projectSlugForCwd()` (`src/engine/event-shim.ts`). The leading dash is
the convention agentic-pi expects; the dashboard's `SessionReader` and
`ChatSessionReader` scan these directories.

### Line format

Each line is a JSON object in Claude-SDK envelope shape:

```jsonl
{"type":"user","message":{"role":"user","content":"..."},"timestamp":"...","sessionId":"..."}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}],"model":"..."},"timestamp":"...","sessionId":"..."}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"...","content":"..."}]},"timestamp":"...","sessionId":"..."}
{"type":"result","subtype":"success","num_turns":7,"total_cost_usd":0.13,"total_input_tokens":...,"stop_reason":"end_turn","timestamp":"..."}
```

The format predates the agentic-pi migration — it's the Claude SDK
shape because that's what the dashboard already knew how to render.
The translation lives in `AgenticShim`.

### Translation rules (`AgenticShim`)

`src/engine/event-shim.ts`:

| agentic-pi event | JSONL envelope |
|---|---|
| `session` | (opens the file; emits the initial `user` envelope with the prompt) |
| `message_end` (assistant) | `assistant` envelope with text + tool_use blocks (thinking blocks dropped) |
| `tool_execution_end` | `user` envelope with `tool_result` block |
| `usage_snapshot` | `result` envelope with cost, tokens, turns, `stop_reason` |
| `fatal_error` | `assistant` envelope with `isApiErrorMessage: true` |

Tool results > 64 KB are truncated with a `…[truncated N chars]`
marker. The raw output remains in workspace files / stdout — only the
JSONL is capped, for dashboard render efficiency.

### Append-only

Lines are never edited or deleted. A resumed workflow that re-enters
the same session id appends to the existing file. No file rotation.

## The split rule

| Store | What goes here | Why |
|---|---|---|
| **SQLite** | Execution lifecycles, costs, phase history, approvals, scratch keys + pointers, schedule overrides, messaging session metadata | Indexed, fast list queries, small rows. The dashboard's list-view query is `ORDER BY <active-first>, started_at DESC LIMIT 20` polled every 5 s — it must return cheaply. The leading key is a `CASE` over `status` (running < paused < queued < terminal) so in-flight runs cannot be paginated off page 1 by a cron fan-out that enqueues a batch newer than the work actually executing — the Live filter hides queued rows, so a date-only sort rendered an empty tab mid-run. |
| **JSONL** | Every agent event in order — assistant messages, tool calls, tool results, usage snapshots, errors | Append-only event stream, unbounded length, one file per session. Lets the dashboard render the full conversation without paging through SQLite blobs. |
| **Build-assets files** (server mode only) | The per-phase handoff docs (`architect-plan.md`, `status.md`, `executor-summary.md`, …) — plus binary screenshot evidence (`*.png`) from the browser-QA phase — when `buildAssets.location = server` | Files under `$STATE_DIR/build-assets/<owner>/<repo>/<issueKey>/` so they're git-free (never committed into the target repo), editable, and servable by the admin Artifacts endpoints. Markdown is served `text/plain`; images via `readBuffer` + a MIME-typed response and rendered in the dashboard's image viewer. Image artifacts are **also** served by an unauthenticated, image-only route (`GET /admin/api/public/artifacts/<owner>/<repo>/<key>/<doc>`, registered on the parent app before the auth-gated `/admin/api` sub-app in `mountAdmin`) so browser-QA screenshots embed inline in a GitHub comment via `{{artifactBaseUrl}}`; non-image docs 404 there, keeping the text handoff docs behind auth. (Public-by-URL — acceptable for public repos; revisit before private.) In the default `repo` mode they live on the target repo's branch instead, not here. Store: `src/state/build-assets.ts`. |

The dashboard's workflow-runs list endpoint excludes `context`,
`scratch`, and `node_statuses` from the `SELECT` so the list query
stays small even when individual runs accumulate megabytes of state.
The detail endpoint uses `SELECT *`.

**`output_text` is the bridge.** When a loop iteration needs to read
its prior output, it doesn't rehydrate the JSONL — it looks up
`scratch.<key>.lastOutputExecutionId`, joins on `executions`, and reads
`output_text` directly. One row, one column, bounded size.

## Migrations

`migrate()` runs on every `new StateDb()` call:

1. `CREATE TABLE IF NOT EXISTS …` for every table.
2. `CREATE INDEX IF NOT EXISTS …` for every index.
3. Additive `ALTER TABLE … ADD COLUMN …` in try/catch for fields
   added since v0.0.1. Old rows have NULLs; new rows respect defaults.

Strategy: never drop, never narrow. Long-running deployments
accumulate schema; SQLite handles it.

`PRAGMA foreign_keys = ON` is set at connection time (better-sqlite3
default behaviour depends on version — the harness sets it explicitly).
A one-shot rebuild of `messaging_sessions` was needed once to remove
an overly strict table-level UNIQUE constraint that blocked legitimate
session recreation after timeouts.

## Invariants

- **No unbounded text in `workflow_runs.scratch`.** Loop iterations
  store an `executions.id` reference; the text lives in `output_text`
  or in JSONL. The fix-marker harvest clamps every field it keeps and
  bounds the rendered attempt journal on both axes, for the same
  reason twice over: it is *also* replayed into every later prompt.
- **`session_id` is the join key between the two stores.** Every
  `executions` row that ran an agent has one; matching the JSONL
  filename joins them.
- **Append-only by default.** Only `cron_overrides` and
  `workflow_overrides` permit deletion; everything else accumulates.
  Audit trail trumps disk usage.
- **JSONL truncation is for display, not retention.** The raw output
  is still on disk somewhere (workspace, stdout). A re-implementation
  that *deletes* the original content based on JSONL truncation is
  losing data.
- **Partial unique index** on `messaging_sessions` allows
  multiple inactive rows but exactly one active per key.
- **A feedback anchor's attribution is write-once.** It is set when the
  artefact is posted (Slack) or when its run finishes (GitHub) — the only
  moments the run is in hand. Nothing recomputes it later, because by then the
  only evidence would be timestamps.
- **List queries exclude blob columns.** The dashboard polls every
  5 s; reading `context` + `scratch` + `node_statuses` for every row
  would dominate the query cost. The list endpoint's projection is
  deliberate.

## Current implementation

| Piece | File |
|---|---|
| `BaseDb` interface, store wiring, shared import surface | `src/state/db.ts` |
| Schema migrations (`CREATE TABLE`/`INDEX`/`ALTER`) | `src/state/migrate.ts` |
| `WorkflowRunStore` — `workflow_runs` + atomic lifecycle ops | `src/state/workflow-run-store.ts` |
| `ExecutionStore` — `executions` table + ops | `src/state/execution-store.ts` |
| `ApprovalStore` — `workflow_approvals` | `src/state/approval-store.ts` |
| `UserStore` — `users` identity + Slack/email matching | `src/state/user-store.ts` |
| `FeedbackStore` — `feedback_anchors` + `feedback_signals` (issue #255) | `src/state/feedback-store.ts` |
| `TeamStore` — the four `github_team*` / `github_visibility_sync` tables (issue #169) | `src/state/team-store.ts` |
| Lazy per-user team→repo resolver (budgets, fail-open, stale-while-revalidate) | `src/engine/github/team-visibility.ts` |
| Emoji → score vocabulary (both surfaces) | `src/engine/feedback/reactions.ts` |
| Reaction → signal ingest + OTel export | `src/engine/feedback/ingest.ts` |
| Slack anchors + live reaction handling | `src/engine/feedback/slack.ts` |
| GitHub anchor discovery + batched reaction poll | `src/cron/feedback-poll.ts` |
| JSONL writer + envelope translation | `src/engine/event-shim.ts` |
| Sandbox session reader (dashboard) | `src/admin/SessionReader.ts` |
| Chat session reader (dashboard, DB-backed) | `src/admin/ChatSessionReader.ts` |
| Session manager (messaging) | `src/connectors/messaging/session-manager.ts` |

## Rebuild notes

- **Pick the split.** Resume state goes to a small, indexed store
  (SQLite, Postgres, any KV). Event stream goes to append-only files
  (JSONL, NDJSON, anything line-oriented). Don't put the event stream
  in the relational store.
- **Don't grow the resume state by accident.** Every blob column you
  add will end up read by the list query. If you find yourself adding
  `large_output TEXT` to a frequently-listed table, you have the
  wrong shape — write it to JSONL or to a separate small table the
  list endpoint doesn't read.
- **Index the list query, not everything.** The hot path is "recent
  rows, status filter, name filter". One descending index by
  `started_at` is doing most of the work.
- **Make `session_id` the join.** It's the only stable id the agent
  runtime hands you; everything else (taskId, workflow_run_id) is
  harness state.
- **Migrate additively.** Drops, narrowings, renames are all
  high-risk on a running system. Adding a column with a NULL default
  is safe.
- **Plan for `restart_count` from day one.** Crash loops are a
  certainty. Cap them at the schema level so a stuck workflow can't
  consume the database.
- **Split the store per table.** The intended pattern (issue #97) is one
  store class per table — `WorkflowRunStore`, `ExecutionStore`,
  `ApprovalStore` — over a shared `BaseDb` interface, with migrations in
  their own module (`migrate.ts`) and `db.ts` kept as the single import
  surface that wires them together. The accessor sprawl that grows on a
  monolithic db file is the thing this avoids.

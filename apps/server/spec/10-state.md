---
title: "State"
order: 10
description: "The relational tables for resume substrate — SQLite by default, Postgres (including Neon) on opt-in — and the per-session JSONL event log for agent transcripts. The split rule: what goes where, why, and how the dashboard reads both."
---

## Purpose

State is split deliberately between two stores:

- **A relational database** — the resume substrate. Indexed, mutable,
  small. Tracks what's running, what's paused, what to do next.
  **SQLite** (`$STATE_DIR/lastlight.db`) is the default and needs
  nothing running; a `postgres://` URL in `DATABASE_URL` selects
  **Postgres** instead — self-hosted, managed (RDS / Cloud SQL /
  Supabase) or serverless (**Neon**). Both are supported production
  stores; see "Dialect posture" below.
- **JSONL** (per-session files under
  `$STATE_DIR/agent-sessions/projects/`) — the event log. Append-only,
  large, streamable. Captures every event the agent emitted, in order.

The split rule is load-bearing: unbounded text never lands in
`workflow_runs` blobs. Large LLM outputs live in JSONL or in
`executions.output_text` (a row the runner points at), never inlined
into the resume state read by every dashboard query.

## State tables

The schema is **declared in Drizzle**, not in DDL: `src/state/schema/sqlite.ts`
is the source of truth for sixteen tables, with `src/state/schema/pg.ts` as its
name-parity Postgres mirror (see "Dialect posture" below). The per-table stores
in `src/state/*-store.ts` operate on them; `src/state/db.ts` wires the stores
together. All rows are append-only unless marked mutable. Migrations are
additive and **journaled** — see "Migrations".

The DDL blocks below are illustration, kept because they read better than the
TypeScript, and are written in the **SQLite** dialect because that is the
default deployment. The authoritative rendering is the generated baseline,
`apps/server/drizzle/sqlite/0000_baseline.sql` (and its `drizzle/pg/` mirror);
when the two disagree, the generated file is right. Table and column names are
identical on both dialects — only the column *types* differ (jsonb-vs-text,
boolean-vs-integer), which is the point of the parity test.

### `executions`

One row per phase execution (sandbox) or chat turn. The bridge between
the resume state and the JSONL.

```sql
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,           -- "webhook" | "cron" | "chat" | "api"
  trigger_id TEXT NOT NULL,             -- issue URL, Slack thread id, etc.
  skill TEXT NOT NULL,                  -- "workflow-name:phase-name" or "chat"
  owner TEXT,                           -- GitHub org/user; composes owner/repo
  repo TEXT,                            -- BARE repo name (path-safe segment)
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

### One repo-identifier rule

`owner` + `repo` together identify the target, on **both** `workflow_runs` and
`executions` (and on `feedback_anchors` / `feedback_signals`, which always did).
`repo` is stored **bare** — a single path-safe segment, because taskIds and
workspace/session dirs derive from it — with the org/user in its own `owner`
column. That pair is also exactly what Octokit takes, so a row read back needs
no splitting before it reaches GitHub.

Everything a *user* sees speaks the qualified `owner/repo` instead:
`getManagedRepos()`, `EventEnvelope.repo`, `PrState.repo`, the artifact-store
slugs, `/me/repos`, the dashboard. **`src/state/repo-ref.ts` is the only place
that join is expressed** — `qualifyRepo` for JS, `qualifiedRepoSql` for SQL, and
`normalizeRepoRef` for the inverse. `createRun` and `recordStart` run every
write through it, and `deserialize` runs every read back through it.

That convergence is issue #279. Before it, the same column meant two things
depending on who wrote it: rows predating the `owner` column held the qualified
string in `repo` itself, and `executions` had no `owner` at all — the dispatcher
wrote qualified there while the phase executor wrote bare, which is every
workflow phase row. Six read sites each re-derived "may be bare or qualified"
and disagreed about which source wins; #278 shipped a filter built on one
reading, compared `lastlight` against `{nearform/lastlight}`, and a non-null
non-match **hides** rows rather than showing them.

A one-shot backfill (`drizzle/sqlite/0001_backfill_repo_refs.sql`) converges both
tables — `workflow_runs`
first, since the `executions` owner is recovered by joining it. Two arms of
compatibility survive, both documented as legacy rather than as the rule: the
`OR repo = ?` branch of `repoMatchClause`, and `normalizeRepoRef` on read-back.
Rows where the account was never captured anywhere cannot be backfilled and
keep a null `owner`; a filter treats those as "no repo, always visible" rather
than hiding them.

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

### `cron_runs`

One row per cron **fire** — scheduled or manual, `workflow:` and `handler:`
crons alike (issues #341/#327).

```sql
CREATE TABLE IF NOT EXISTS cron_runs (
  id TEXT PRIMARY KEY,
  cron_name TEXT NOT NULL,              -- THE key; never the workflow's name
  workflow TEXT,                        -- null for a handler: cron
  handler TEXT,                         -- null for a workflow: cron
  source TEXT NOT NULL,                 -- schedule | manual
  actor TEXT,                           -- who pressed "Run now"; null if scheduled
  started_at TEXT NOT NULL,
  finished_at TEXT,                     -- null while running
  status TEXT NOT NULL DEFAULT 'running', -- running -> ok | partial | failed
  repos_eligible INTEGER,               -- managed repos considered
  repos_scanned INTEGER,                -- repos that participated (issue #180)
  discovered INTEGER,                   -- PRs found; null for a non-discovery cron
  dispatched INTEGER,
  failures INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_name_started ON cron_runs(cron_name, started_at DESC);
```

**Why it exists.** A cron whose only work is discovery + fan-out can complete
having dispatched **zero** runs — the normal steady state for a backstop sitting
behind a webhook. It then writes no `workflow_runs` row and no `executions` row,
so the dashboard showed nothing, indistinguishable from a cron that failed or
never ran. This ledger is the only record such a fire leaves.

**Why it is keyed on `cron_name`.** The same workflow is reachable from
`/api/run`, a GitHub comment and Slack. Keyed on the workflow, a hand-triggered
failure moved the cron's health and vice versa. Keyed on the cron, only its own
fires count — which is what makes `CronRunStore.recentFailures` a sound input to
the scheduler's consecutive-failure alert (issue #327).

**Why not overload `executions`.** It carries no column for a fan-out's counts,
its `success` flag is binary so a `partial` fire has nowhere to live, and its
`success = 0` population is dominated by DAG-cascade skips and `ResourceQuota`
deferrals — 251 in one day against zero real failures on a live instance — which
are deliberately `success = 0` and must stay so. A cron-fire row is written by
exactly one writer and cannot contain either.

Both reads (`latestByCron`, `recentFailures`) tie-break on `id`, so ordering does
not depend on `started_at` being distinct. The tiebreak used to be `rowid`
(insertion order), which Postgres has no equivalent for; `id` is a UUID, so the
order within a same-timestamp tie is arbitrary but **stable**, which is all
either read needs — and a tiebreak that is merely deterministic is not enough
here, because dropping it entirely makes `recentFailures` report 0 for an
always-failing cron.

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

### `activity_log`

One row per **user-initiated action**, across the dashboard, CLI, Slack, GitHub
and cron (issue #206). Append-only: never updated, never deleted.

```sql
CREATE TABLE activity_log (
  id TEXT PRIMARY KEY,                  -- creation-ordered; see the tiebreak note
  created_at TEXT NOT NULL,
  actor_login TEXT,                     -- soft join to users.login; null without a verified login
  actor_type TEXT,                      -- reuses TriggerActorType (#205)
  action TEXT NOT NULL,                 -- the verb: login, cron.toggle, workflow.cancel, …
  target_type TEXT,                     -- workflow_run | cron | workflow | repo | approval | pr | container
  target_id TEXT,                       -- the bare id: a run id, a cron name, owner/repo
  outcome TEXT NOT NULL,                -- ok | denied | error
  detail TEXT                           -- small flat JSON summary; jsonb on Postgres
);
CREATE INDEX idx_activity_created ON activity_log(created_at DESC);
CREATE INDEX idx_activity_actor_created ON activity_log(actor_login, created_at DESC);
CREATE INDEX idx_activity_target ON activity_log(target_type, target_id);
```

**Why it exists.** #205 put a real actor on every run and execution, but the
answer to "what has this person done?" was spread across five ledgers —
`workflow_runs.triggered_by`, `executions`, `workflow_approvals.responded_by`,
`cron_overrides.updated_by`, `workflow_overrides.updated_by` — and several
actions (login, config edits, container kills, artifact edits) wrote to none of
them. This is the chronological stream that answers it without a five-way join.

**It complements #205's columns; it does not replace them.** `triggered_by`
stays the hot-path per-run attribution the run detail view reads. This is the
audit stream layered on top, joined to `users` on `login`.

**Why not overload `executions`.** The same three reasons `cron_runs` did not
(above): `executions` carries no column for an action that is not an agent
invocation, its `success` flag is binary so `denied` has nowhere to live, and
its `success = 0` population is dominated by DAG-cascade skips and quota
deferrals that must stay `success = 0`.

**Why only user-initiated actions.** A cron fan-out dispatches once per repo, so
recording each as an action would make the dominant row source a thing no human
did — the same confusion `cron_runs` avoids by keying on `cron_name` rather than
the workflow. `workflow.trigger` is therefore written only for a human actor
type (`github` / `slack` / `cli` / `admin`), and a cron fire is recorded once, at
its cause, as `cron.fire`. The result grows more slowly than `workflow_runs`
itself, which is what makes deferring a retention policy safe.

**`actor_login` is nullable and has no foreign key.** Nullable because a
password login and an auth-disabled instance carry no verified login — a null
actor is a truer statement than the literal `"admin"` the `updated_by` columns
fall back to. No FK because the join to `users` is the same additive enrichment
#205 chose, so a row survives an actor who never logged into the dashboard.

Reads tie-break on `id`, which is minted in creation order
(`activity-store.ts` → `creationOrderedId`, the same helper shape as
`cron-run-store.ts`). Postgres has no `rowid`, and a merely arbitrary tiebreak
is not enough for a **paged** read: a page boundary falling inside a
same-millisecond run of rows would skip or repeat them between pages.

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
| **Relational DB** (SQLite or Postgres) | Execution lifecycles, costs, phase history, approvals, scratch keys + pointers, schedule overrides, messaging session metadata | Indexed, fast list queries, small rows. The dashboard's list-view query is `ORDER BY <active-first>, started_at DESC LIMIT 20` polled every 5 s — it must return cheaply. The leading key is a `CASE` over `status` (running < paused < queued < terminal) so in-flight runs cannot be paginated off page 1 by a cron fan-out that enqueues a batch newer than the work actually executing — the Live filter hides queued rows, so a date-only sort rendered an empty tab mid-run. |
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

The schema is declared once in `src/state/schema/sqlite.ts` (Drizzle) and
applied by a **journaled migrator**. `StateDb.open()` runs three steps, in
order:

1. **`applyLegacySqliteCompat()`** (`src/state/legacy-sqlite.ts`) — a
   sqlite-only, idempotent pre-step for deployments older than the current
   column set. `CREATE TABLE IF NOT EXISTS` no-ops on a table that exists but
   is missing columns a later release added by `ALTER`, so the baseline alone
   cannot bring an old database up to date. Guarded by `PRAGMA table_info`
   rather than try/catch, so a real failure is not swallowed. It also carries
   the one-shot `messaging_sessions` rebuild that strips an overly strict
   table-level UNIQUE — it blocked legitimate session recreation after a
   timeout, and a partial unique index (`WHERE active = 1`) replaced it.
2. **`0000_baseline.sql`** — the full current schema, hand-edited so every
   statement carries `IF NOT EXISTS`. On the existing production database
   every statement no-ops; the migrator then records it and all later
   migrations proceed normally. Hand-editing a migration is an anti-pattern
   except exactly here: a baseline over a journal-less legacy database.
3. **`0001_backfill_repo_refs.sql`** and onward — ordinary generated
   migrations, never hand-edited. `0001` is a DATA migration (the issue-#279
   `(owner, BARE repo)` normalization and the `feedback_anchors.channel`
   sentinel). Its statement ORDER is load-bearing: `workflow_runs` must be
   normalized before `executions`, which reads `workflow_runs.owner` back out.

Applied migrations are recorded in `__drizzle_migrations`, so each runs
**once**. They previously re-executed on every boot and were idempotent only
by hand-maintained convention (issue #345).

Strategy is unchanged: never drop, never narrow. Long-running deployments
accumulate schema; both dialects handle it.

**Adding a migration** means editing **both** schema files and regenerating
**both** dialects:

```bash
# edit src/state/schema/sqlite.ts AND src/state/schema/pg.ts
pnpm --filter lastlight-core run db:generate:sqlite
pnpm --filter lastlight-core run db:generate:pg
```

`tests/state/schema-parity.test.ts` fails if the two drift. Generated
migrations only — **never** point `drizzle-kit push` at a real database: it
diffs against the declared schema and emits DROPs for anything it doesn't know
about, and production carries two orphan tables from an older migrator
(`rate_limits`, `system_status`) that nothing in the tree declares or reads.

## Dialect posture

The state layer is written once and runs on two dialects. **Both are supported
production stores**; SQLite remains the default and the one that needs nothing
running.

- **SQLite via libsql** (`@libsql/client` + `drizzle-orm/libsql`) — the default.
  `StateDb.open()` builds it for `:memory:`, a `file:` URL or a bare path.
- **Postgres** — an external or managed server, selected by a `postgres://`
  URL in `DATABASE_URL` / `database.url`. `StateDb.open()` builds a real pooled
  client and runs the `drizzle/pg` migrator against it.

**The choice is made at deploy time and is one line of config.**
`lastlight server setup` asks it directly ("Where should Last Light keep its
state?"), defaulting to SQLite; picking Postgres prompts for the URL, TCP-probes
the host, reports the driver it detected, and writes the value to
`instance/secrets/.env`. Nothing else in the deployment changes: the compose
stack, the overlay, the sandbox backends and every workflow are identical either
way. Choosing SQLite writes **nothing at all** — no `DATABASE_URL` line and no
`database:` block — because that absence is what lets the slot resolve to
`file:` + `$STATE_DIR`, which `STATE_DIR` is supposed to be free to move.

Pick SQLite unless you have a reason not to: it needs no server, and the whole
database is one file inside the volume you already back up. Pick Postgres when
the state has to outlive the host (a managed server or Neon survives the VM
being rebuilt), when something else needs to read it, or when your operational
tooling already assumes Postgres. It is not a performance decision at Last
Light's write volume, and it is **not** a step towards running more than one
instance — see the note below.

**The driver is a second, narrow choice** (`database.driver`, env
`DATABASE_DRIVER`), because the same `postgres://` dialect can be carried two
ways:

| driver | package | for |
|---|---|---|
| `pg` (default) | `pg` — a TCP pool | self-hosted, RDS, Cloud SQL, Supabase's pooler |
| `neon` | `@neondatabase/serverless` — a WebSocket pool | Neon serverless Postgres |

Unset, it is auto-detected from the host (`*.neon.tech` → `neon`, else `pg`);
an explicit value always wins, which is the only way to express Neon behind a
custom domain. `drizzle-orm/neon-http` is deliberately **not** an option: it
cannot run interactive transactions, so the nine transaction sites would
type-check, pass a smoke test, and silently stop being atomic.

**Postgres here is a storage choice, not multi-instance HA.** Last Light runs
one instance and the named atomic ops rely on a connection-scoped in-process
mutex (`makeOpSerializer`), which no second process would share.

Both drivers are runtime dependencies, but each is loaded through a **dynamic
import inside its own builder** in `src/state/pg-client.ts` — which is itself
only reached from `open()`'s postgres branch. So a SQLite deployment loads
neither, and a node-postgres deployment never loads the Neon driver.
`tests/state/driver-isolation.test.ts` fails if a static import appears.

Three drift guards keep the two dialects honest:

1. The **parity test** pins names, nullability, PKs and index structure across
   the two schemas (deliberately **not** column types — jsonb-vs-text and
   boolean-vs-integer divergence is the point).
2. The **PGlite leg** runs the entire state suite and the `SessionManager`
   suite a second time against real Postgres compiled to WASM
   (`tests/state/db.pg.test.ts`,
   `tests/connectors/messaging/session-manager.pg.test.ts`), hermetically, in
   the default test command.
3. The **real-server leg** (`tests/state/db.pg-server.test.ts`, opt-in via
   `PG_INTEGRATION=1`, its own CI job) runs it a third time over node-postgres
   and a connection pool. This exists because PGlite proves the *dialect* but
   not the *driver*: it parses int8 to a number itself, so it cannot catch a
   missing `setTypeParser(20, …)` — without which every `COUNT(*)`/`SUM()`
   arrives as a **string** and the stats rollups concatenate instead of adding.
   It is also single-connection, so the pool and the real `.rowCount` /
   SQLSTATE-`23505` error shapes are only exercised there.

`schema/pg.ts` is imported by exactly one module under `src/` —
`state/pg-client.ts`, which needs it to build the client (`tablesOf()` reads
the schema back off the Drizzle instance, and one built with the *sqlite*
schema would send `1` into a `boolean` and `JSON.parse` an already-parsed jsonb
value). Nothing else may name it; the isolation test pins that too.

What actually differs is funnelled through **`src/state/dialect.ts`** — raw-SQL
execution (`rows`), rows-affected (`changes`), unique-violation detection
(`isUniqueViolation`), `LIKE` escaping, the `substr`-based day/hour buckets, and
the boolean rollup helpers. A store that reaches around that seam is a
portability bug. Timestamps stay ISO-8601 `text` in both dialects (lexicographic
ordering, dialect-neutral bucketing, zero data migration); JSON columns are
`text({mode:'json'})` on sqlite and real `jsonb` on Postgres, with the same
`$type<T>` on both so the store-facing type is identical.

## Async API

Every store method returns a `Promise`. `StateDb` is built by an **async
factory** — there is no public constructor:

```ts
const db = await StateDb.open(urlOrPath);          // production
const db = StateDb.fromClient(client, "postgres"); // tests, DI
```

`open()` normalizes what it is given (locked plan decision 9): `:memory:` passes
through, a `file:` URL passes through, `postgres(ql)://` takes the Postgres
branch, and anything else is treated as a filesystem path (resolved, then
`file:`-prefixed). Callers never build `file:` URLs themselves. On the sqlite
path it then sets the boot pragmas (`journal_mode=WAL`, `busy_timeout=5000`),
runs the legacy pre-step, and applies `drizzle/sqlite`; on the Postgres path it
resolves the driver, builds a pool and applies `drizzle/pg`. `close()` is async
too, and on Postgres it is load-bearing — it drains the pool.

**Where the URL comes from**, first hit wins: the `DATABASE_URL` env var → the
overlay's `database.url` → `config/default.yaml`'s `database.url` (ships
`null`) → `file:` + `config.dbPath`, i.e. `DB_PATH` or
`$STATE_DIR/lastlight.db`. The last case is the pre-Drizzle behaviour, so an
existing deployment that sets none of them changes nothing.

**A `postgres://` URL belongs in `DATABASE_URL` (the gitignored
`instance/secrets/.env`), never in the overlay `config.yaml`.** `database.url`
is a real YAML slot, so putting it there is the obvious move and it is wrong:
the overlay is a git repo with a GitHub remote, and the dashboard's masking
happens at render time, which cannot un-commit anything. `lastlight server
setup` therefore writes this one slot through `buildEnvContent()` — the only
config value it treats as a secret.

**Credential redaction.** `redactPublic()` masks the userinfo of any string
that is a `postgres://` URL, wherever it appears in the public config bundle,
and the boot log passes `dbTarget` through the same `redactDbUrl()`. The rule
is by VALUE rather than by key because `SENSITIVE_KEY_RE` must not match `url`
(that would blank `publicUrl`, `avatarUrl` and friends) — and because a `file:`
URL should stay legible in the provenance view, which is the whole point of it.

## Moving an existing database to Postgres

`src/state/data-migrate.ts` + the `lastlight-state` entry point copy a live
SQLite database into a Postgres one, one way:

```bash
lastlight server db check                  # can the agent reach the server?
lastlight server db migrate --dry-run      # per-table row counts, writes nothing
lastlight server db migrate                # copy, then verify counts
```

The CLI runs these **inside the agent image** (`docker compose run --rm
--no-deps --entrypoint node agent /app/dist/state/state-cli.js …`), because
`packages/cli` may never gain an edge to `lastlight-core`, where the drivers
and schemas live. With no `--to`, the container's own `DATABASE_URL` is the
target, so the credential never reaches the host's process list.

It is a read-and-insert loop through the two Drizzle schemas, not a
dump/restore, and that is the design: both schemas carry the same `$type<T>` on
every column, so the JS value in the middle is dialect-neutral. A text
transport would have to know that `success` is `0/1` here and `false` there,
and that `context` is a string here and a document there.

Four properties, each of which is a data-loss bug if dropped:

- **Both ends are migrated first** — each side is opened through
  `StateDb.open()`, so a source that is behind on migrations is brought current
  before anything is read. Opening it is a WRITE, so the agent must be stopped
  (the CLI checks, and offers to stop it).
- **FK order** — `messaging_sessions` before `messaging_messages`, the only
  declared foreign key in the schema. `TABLE_ORDER` encodes it.
- **The target must be empty** unless `--truncate` — copying into a populated
  database half-succeeds on PK collisions and leaves an interleaved mess.
- **Coverage is checked against the schema's own exports** on every run, so a
  sixteenth table added later fails loudly instead of being silently skipped.

`messaging_messages.id` is the one value that does not survive: it is
`AUTOINCREMENT` on SQLite and `GENERATED ALWAYS AS IDENTITY` on Postgres, which
rejects an explicit value. Nothing references it, and rows are read in id
order, so the message sequence is preserved. Two other differences are inherent
and immaterial: Postgres normalizes **jsonb key order**, and `SUM()` over
floats accumulates in a different order (a last-ULP difference in
`dailyStats().costUsd`; the per-row `cost_usd` values are identical).

Verified against a 43 MB copy of drizby production (4,666 rows across all
fifteen tables): 0.7 s, every row of `executions` and `workflow_runs`
field-for-field identical modulo jsonb key order, and the harness boots and
writes against the result.

Two consequences worth stating, because they are not local to this page:

- **`lastlight-workflow-engine`'s ports are async.** `RunStore`,
  `ExecutionLedger` and `PhaseReporter` declare `Promise<T>`; `StateDb`
  satisfies them structurally, fenced by
  `tests/workflows/state-store-contract.test.ts`.
- **`:memory:` is unsafe for anything that transacts.** The libsql local client
  hands its single connection to each `client.transaction()` and lazily opens a
  *new* one for the next query — against `:memory:` that new connection is a
  fresh, empty database, so the whole store silently vanishes after the first
  commit. Tests use `makeTestDb()` (`tests/helpers/state-db.ts`), a per-test
  temp file. Same root cause: `busy_timeout` is connection-scoped and does not
  survive a transaction, so the connection-scoped op serializer in
  `src/state/client.ts` — not the pragma — is the load-bearing concurrency
  defense for the nine transaction sites.

## Wire contract

`/admin/api/executions` (and the other execution list routes) serve
**camelCase**, matching `dashboard/src/api.ts` exactly: `triggerType`,
`triggerId`, `startedAt`, `durationMs`, and `success?: boolean` — a real
boolean, `null`/absent while the row is still running. Drizzle's mapped rows
already have that shape; nothing re-serializes them. `ExecutionStore` holds one
aliased column list and one row mapper (issue #285) and every record-returning
read goes through both. `tests/admin/executions-wire.test.ts` pins it, including
that no `trigger_id`-style key leaks.

The one place the boolean change bites: a `success === 0` comparison silently
becomes `false` under boolean column mode. `consecutiveFailures()` reads
`=== false`; an inversion there turns every cron-failure alert off, which is why
it carries its own test.

The one declared foreign key (`messaging_messages.session_id`) **is enforced**.
Nothing sets `PRAGMA foreign_keys` explicitly — this document used to claim the
harness did — but both drivers default it on and reject an orphan insert, so it
has always bitten. The rebuild in step 1 toggles it off around its table swap
precisely because of that.

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
- **A read that returns an `ExecutionRecord` aliases every column.** The
  table is snake_case and the record is camelCase, so `SELECT *` cast to
  `ExecutionRecord[]` type-checks and silently yields `undefined` for every
  multi-word field — `issueNumber`, `startedAt`, `workflowRunId` (issue #285).
  It is not detectable by the compiler and it was not detectable by a test that
  never read those fields, so three reads had drifted: the Slack status report
  rendered `(started undefined)` and the admin cancel loop filtered
  `runningExecutions()` on a `workflowRunId` that matched no row. `ExecutionStore`
  now holds ONE aliased column list and ONE row mapper, shared by all four
  record-returning reads, so a new column is added to both or to neither.

## Current implementation

| Piece | File |
|---|---|
| `StateDb` — async `open()` / `fromClient()` factory, store wiring, shared import surface | `src/state/db.ts` |
| The Drizzle client, `tablesOf()`, and the connection-scoped op serializer | `src/state/client.ts` |
| The portability seam (`rows` / `changes` / `isUniqueViolation` / buckets) | `src/state/dialect.ts` |
| Schema declaration — sqlite source of truth + Postgres name-parity mirror | `src/state/schema/sqlite.ts`, `src/state/schema/pg.ts` |
| Generated migrations (journaled; shipped in the npm tarball and the image) | `drizzle/sqlite/`, `drizzle/pg/` |
| Pre-migrator compat step for pre-baseline deployments | `src/state/legacy-sqlite.ts` |
| `WorkflowRunStore` — `workflow_runs` + atomic lifecycle ops | `src/state/workflow-run-store.ts` |
| `ExecutionStore` — `executions` table + ops | `src/state/execution-store.ts` |
| `ApprovalStore` — `workflow_approvals` | `src/state/approval-store.ts` |
| `CronRunStore` — `cron_runs`, one row per cron fire (issues #341/#327) | `src/state/cron-run-store.ts` |
| `UserStore` — `users` identity + Slack/email matching | `src/state/user-store.ts` |
| `ActivityStore` — `activity_log`, one row per user action (issue #206) | `src/state/activity-store.ts` |
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
- **Migrate additively, and journal it.** Drops, narrowings, renames are all
  high-risk on a running system. Adding a column with a NULL default
  is safe. Record each migration as applied so it runs once — boot-time DDL
  that re-executes forever is idempotent only by hand-maintained convention,
  and that convention cannot express a data backfill.
- **Plan for `restart_count` from day one.** Crash loops are a
  certainty. Cap them at the schema level so a stuck workflow can't
  consume the database.
- **Split the store per table.** The intended pattern (issue #97) is one
  store class per table — `WorkflowRunStore`, `ExecutionStore`,
  `ApprovalStore` — over **one shared query client with a dialect seam**, with
  the schema declared in its own module and `db.ts` kept as the single import
  surface that wires them together. The accessor sprawl that grows on a
  monolithic db file is the thing this avoids.
- **If a second database might ever matter, make the store API async on day
  one.** Sync-over-a-sync-driver is the decision that is expensive to undo: the
  flip rippled through every store, every consumer, the workflow engine's
  published ports and ten test files. The dialect seam was the cheap part.

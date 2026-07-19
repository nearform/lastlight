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

`src/state/migrate.ts` defines six tables (the per-table stores in
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
  output_text TEXT                      -- large final assistant text for loop iterations
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
  finished_at TEXT
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
| **SQLite** | Execution lifecycles, costs, phase history, approvals, scratch keys + pointers, schedule overrides, messaging session metadata | Indexed, fast list queries, small rows. The dashboard's list-view query is `ORDER BY started_at DESC LIMIT 20` polled every 5 s — it must return cheaply. |
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
  or in JSONL.
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

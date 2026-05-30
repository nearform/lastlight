---
title: "Harness"
order: 1
description: "The supervisor process. Boot sequence, lifecycle, the wiring that connects integrations, the router, the workflow engine, the sandbox, and the chat path. Crash recovery and signal handling."
---

## Purpose

The harness is the long-lived Node process that owns the system. It validates
configuration, brings up each integration that has credentials, wires them
all to a single dispatch closure, mounts the admin dashboard, registers
cron jobs, recovers any workflow runs interrupted by a prior crash, and
then waits on signals.

Everything else in this spec is reachable from here. If the harness is the
only thing that exists, every other layer is just a function it calls.

## Inputs and outputs

| Direction | Boundary | What flows |
|---|---|---|
| In | Environment | All [Configuration](/spec/02-configuration) — env vars, secrets paths, model/variant overrides |
| In | Disk | `STATE_DIR/lastlight.db`, `STATE_DIR/secrets/app.pem`, prior workflow_runs rows |
| In | Network | GitHub webhooks (HTTPS), Slack Socket Mode (WebSocket), admin dashboard HTTP, CLI POSTs |
| In | OS | `SIGINT`, `SIGTERM` |
| Out | Disk | Updated SQLite rows, JSONL event logs, regenerated egress firewall configs |
| Out | Network | GitHub API calls, Slack replies, dashboard HTML/JSON |
| Out | OS | Exit codes — `0` (clean), `1` (runtime error), `78` (`EX_CONFIG`, do not restart) |

## Boot sequence

The order is load-bearing — DB before chat, cron scheduler before admin
mount, connectors registered before `startAll()`, recovery before "ready".
A re-implementation must reproduce these dependencies even if the names
differ.

1. **Config + pre-flight** — load env, validate. Exit `78` on missing
   GitHub App PEM or malformed config so process supervisors back off
   instead of looping. (`src/index.ts:60–66`, validator at `30–58`.)
2. **Orphaned sandbox cleanup** — kill any sandbox containers / VMs left
   behind by a prior crash. (`75`.)
3. **State directory** — `mkdir -p` `logs/`, `sandboxes/`, `agent-sessions/`,
   then regenerate the egress firewall configs (`nginx-*.conf`,
   `Corefile.*`) for the docker backend. (`78–89`.)
4. **Database** — open SQLite, run migrations, build the `StateDb`
   instance. Every later step needs this. (`94`.)
5. **Session manager** — wraps the DB for messaging connectors. (`98`.)
6. **Chat runner** — load the curated chat skill catalogue
   (`loadChatSkillCatalogue` → XML `<available_skills>` block + a
   `read_skill` tool), then construct the in-process `ChatRunner` with
   model + thinking + system prompt (`agent-context` + chat suffix +
   skill catalogue XML) and the merged toolset (github + `read_skill`).
   Lives in the same process — no sandbox. See [Chat](/spec/11-chat).
7. **Git auth bootstrap** — if a GitHub App is configured, attempt to mint
   an installation token. Non-fatal — logs and continues; tokens are
   refreshed per-execution anyway. (`118–126`.)
8. **GitHub API client** — Octokit wrapper used by harness-side code
   (comments, checks, label fetches). Not the same as the GitHub MCP
   tools the agent uses. (`129`.)
9. **`dispatchWorkflow()` closure** — defined once (`140–380`), captured by
   every later caller (event handler, cron, API endpoints, approval
   resume, explore reply). All workflow dispatch funnels through this one
   function.
10. **Connector registry** — instantiate empty, then conditionally register:
    - **GitHub webhook connector** — requires both `webhookSecret` AND
      `githubApp` config. Exposes a Hono app (the HTTP server). (`390–397`.)
    - **Slack connector** — requires `SLACK_BOT_TOKEN`; no HTTP server
      needed (Socket Mode). (`400–418`.)
11. **Cron scheduler** — construct with the DB + a fan-out callback that
    invokes `dispatchWorkflow()` per managed repo. (`424–435`.)
12. **Admin dashboard** — only if the GitHub webhook connector exists.
    Mounts on `/admin` of its Hono app. (`438–479`.) Without GitHub
    webhook there is no HTTP server at all and the dashboard silently
    does not exist.
13. **API endpoints** — `/api/run` and `/api/build`, same conditional —
    they need the Hono app. (`481–557`.)
14. **Event registry** — `registry.onEvent(handler)` registers the central
    routing callback. Every envelope arriving from any connector is
    routed through `routeEvent()` (the [Router](/spec/05-router)) and then
    dispatched to one of: chat, chat-reset, status-report, approval-response,
    explore-reply, pr-fix, github-orchestrator, or a generic workflow.
    (`560–1124`.)
15. **Cron job registration** — `getJobs({ webhooksEnabled, db })` returns
    a different list depending on whether webhooks are active. With
    webhooks: only scheduled crons (health, security). Without: also the
    polling crons that scan for new issues/PRs. (`1126–1137`.)
16. **`registry.startAll()`** — finally start every registered connector.
    Webhooks start accepting requests; Slack opens the Socket Mode
    connection. (`1138–1141`.)
17. **`resumeOrphanedWorkflows()`** — scan `workflow_runs` for rows in
    `running` state from a previous lifetime, mark their stale executions
    failed, and re-dispatch each so the runner picks up at its last
    completed phase. `paused` rows are left alone — they're waiting on
    humans. (`1145–1169`.)
18. **Ready** — log `[main] Ready to receive events`. (`1171`.)
19. **Signal handlers** — `SIGINT` / `SIGTERM` trigger `shutdown()`: stop
    cron, stop connectors, close DB, `process.exit(0)`. (`1173–1184`.)

## Invariants

- **Single dispatch path.** Every workflow run goes through
  `dispatchWorkflow()`. The closure captures the github client, slack
  poster, models, variants, approval config, bootstrap label, public URL,
  and state dir at construction time. Mutating any of these post-boot
  would not propagate.
- **HTTP server is provided by the GitHub webhook connector.** No
  standalone listener. The admin dashboard, `/api/run`, and `/api/build`
  all silently disappear if there is no GitHub App configured.
- **`StateDb` is built before `ChatRunner`.** The session manager backing
  the chat runner needs the DB at construction. Reorder and chat breaks.
- **Cron scheduler is built before the admin dashboard.** Admin needs the
  scheduler instance to render the jobs panel. Jobs themselves are
  registered *after* the mount, on a separate step (`1131`).
- **Recovery is non-blocking.** `resumeOrphanedWorkflows()` is awaited but
  its rejection is `.catch()`-logged — boot completes even if recovery
  throws on a malformed row. The `[main] Ready` log fires regardless.
- **No mid-boot exits.** Apart from the upfront config validator (which
  exits `78`), the boot path either succeeds or logs warnings and
  continues. A missing Slack token is not fatal; a missing GitHub App is
  not fatal. Fatal-or-continue is decided at config validation, not
  scattered through boot.
- **Restart-driven idempotency.** Resume relies on the runner's
  per-(workflow_run_id, phase_name) dedup check (`shouldRunPhase()`):
  completed phases are not re-executed, in-flight phases are confirmed by
  liveness check, and the worst-case is a phase running twice — the
  runner is built to tolerate that.
- **Exit codes are semantic.** `78` (`EX_CONFIG`) tells Docker / systemd /
  k8s that restarting will not help. `1` is everything else.

## Current implementation

Single file: `src/index.ts`. The dispatch table and routing branches live
in lines `560–1124`. Boot sequence is lines `60–1184`. Resume callbacks
that the connectors invoke (approval response → resume, Slack reply →
explore-reply) are also defined inside this file because they all need
the captured `dispatchWorkflow()` closure.

Supporting files referenced by name during boot:

| Step | File |
|---|---|
| Config validation | `src/config.ts` |
| Orphaned-sandbox cleanup | `src/sandbox/index.ts` |
| Egress firewall config generation | `src/sandbox/egress-firewall-config.ts` |
| `StateDb` | `src/state/db.ts` |
| `ChatRunner` | `src/engine/chat-runner.ts` |
| Git auth bootstrap | `src/engine/git-auth.ts` |
| `GitHubWebhookConnector` | `src/connectors/github-webhook.ts` |
| `SlackConnector` | `src/connectors/slack/index.ts` |
| `CronScheduler` + `getJobs()` | `src/cron/*` |
| Admin dashboard mount | `src/admin/index.ts` |
| Router | `src/engine/router.ts` |
| `dispatchWorkflow` → `runSimpleWorkflow` | `src/workflows/simple.ts` |
| `resumeOrphanedWorkflows` | `src/workflows/resume.ts` |

## Rebuild notes

The harness shape is the part of Last Light that most resists being
"just" ported. It is not a library — it is a process with strict
ordering, captured-closure dispatch, and a feature gate (the HTTP server)
that conditions admin + API on the GitHub integration. A re-implementation
should preserve:

- **Strict boot ordering.** Some languages reach for parallel boot
  (`tokio::join!` etc.) — resist. The dependency edges between DB,
  session manager, chat runner, cron scheduler, admin dashboard, and
  connectors are real.
- **One dispatch surface.** Even if you replace closures with structs +
  methods, every event source (webhook, Slack, cron, CLI, admin) should
  funnel through a single dispatch function with one signature. The
  router decides; the harness only routes the decision.
- **Single HTTP server, shared by integrations.** Mounting admin + API on
  the same listener the GitHub webhook uses is intentional: it keeps the
  process boundary small and means there is one place to terminate TLS,
  one place to put auth, one port to expose. A separate admin port adds
  surface area for little benefit.
- **Recovery is part of the contract, not an afterthought.** Any
  re-implementation must scan persistent state on boot and resume
  in-flight runs. The alternative — leaving workflow_runs `running` until
  a human notices — is silently broken.
- **Choose a non-restart-prone exit code for config errors.** Docker
  health-checks loop on exit `1`; `78` (`EX_CONFIG`) is widely respected
  by supervisors. Pick a code that signals "do not retry".
- **Graceful shutdown is a fixture, not a feature.** The cron scheduler,
  connectors, and DB all need explicit `stop()` calls on `SIGTERM` so
  half-flushed writes do not corrupt the resume substrate. Plan for it
  from day one.

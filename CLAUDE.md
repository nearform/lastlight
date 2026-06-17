# Last Light — Development Guide

> **Architectural reference:** `spec/README.md` is the rebuild-grade
> specification — twelve pages covering every layer with schemas,
> invariants, and rebuild notes. Use this CLAUDE.md for day-to-day
> orientation; use `spec/` when you need the contract.
>
> **OpenCode → agentic-pi:** parts of this file still reference OpenCode
> (the original runtime). The current runtime is `agentic-pi` for
> sandboxed phases and `pi-ai` for in-process chat. The spec reflects
> the current state; this guide will be updated in a follow-up pass.

A GitHub repository maintenance agent. It listens for events (GitHub webhooks
and Slack messages), classifies them, and runs an AI agent against a target
repo via the **OpenCode** runtime (`sst/opencode`). Everything non-trivial —
triage, PR review, the full Architect→Executor→Reviewer build cycle, health
reports — is expressed as a **YAML workflow** the harness executes
phase-by-phase.

## Runtime

OpenCode is provider-agnostic. The harness defaults to
`openai/gpt-5.5` and accepts any `provider/model` string OpenCode
supports (`anthropic/…`, `openai/…`, `openrouter/<vendor>/<model>`, etc.).
API credentials are read from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
and/or `OPENROUTER_API_KEY` on the harness env; set whichever provider(s)
match your `OPENCODE_MODEL` / `OPENCODE_MODELS`. No `claude` CLI, no
Anthropic SDK in the runtime path.

The cheap-helper path (`src/engine/llm.ts`, used by screener + classifier)
bypasses OpenCode and dispatches directly to the same three providers.
`defaultFastModel()` prefers Anthropic > OpenAI > OpenRouter when multiple
keys are set — direct provider routes avoid OpenRouter's per-token markup
when possible.

Two execution surfaces:
- **Sandbox** — `opencode run --format json` invoked per workflow phase
  inside a Docker container (`src/sandbox/docker.ts`). Stream parsed to
  capture session id, tokens, cost, stop reason. Used by every YAML
  workflow.
- **`opencode serve` (chat)** — one long-lived HTTP server on harness
  boot. Each messaging thread maps to one OpenCode session; `POST
  /session/{id}/message` per turn. Replaces the in-process Agent SDK
  query() the chat path used pre-fork.

Both surfaces write a Claude-SDK-style envelope jsonl to
`$STATE_DIR/opencode-home/projects/<slug>/<sessionId>.jsonl` (the
"shim") so the dashboard's `SessionReader` keeps working unchanged. The
shim is `src/engine/opencode-shim.ts`.

## Repo layout

```
src/
  index.ts              Main entry — wires connectors, boots opencode
                        serve, starts the cron scheduler and admin dashboard.
  config.ts             Layered config load: config/default.yaml +
                        optional $LASTLIGHT_OVERLAY_DIR/config.yaml + env
                        overrides. Secrets stay env-only. Exposes
                        getRuntimeConfig / getManagedRepos / getRoutes /
                        getPublicConfig.
  cli.ts                Thin client that POSTs to a running server.
  connectors/           Platform abstraction — every event source emits an
                        EventEnvelope so the engine never sees raw payloads.
    github-webhook.ts   GitHub App webhook → EventEnvelope.
    slack/              Slack Socket Mode + mrkdwn formatter.
    messaging/          Base class for all messaging platforms
                        (slack now, discord later). Owns SessionManager — the
                        per-thread conversation store.
  engine/
    router.ts           Deterministic, code-based routing of EventEnvelope
                        → { skill, context }. Classifies build intent via a
                        small LLM call. No LLM decides the tab.
    opencode-executor.ts  Runs one agent session via opencode run inside a
                        Docker sandbox. Parses --format json stream for
                        tokens / cost / session id / stop reason and feeds
                        the dashboard shim.
    opencode-chat-server.ts  Supervisor + typed HTTP client for the
                        long-lived opencode serve process. Per-session
                        in-flight chain serializes same-sessionId calls
                        (e.g. two messages in one Slack thread) while
                        keeping cross-session traffic parallel.
    chat.ts             Chat skill — creates/resumes an OpenCode session
                        per Slack thread, posts the turn, writes the
                        dashboard envelope jsonl, returns ChatResult
                        metrics for the executions row.
    opencode-shim.ts    ClaudeJsonlShim: translates OpenCode events
                        (text / tool_use / error) into Claude-SDK
                        envelope jsonl lines under opencode-home/projects/.
                        MCP tool name shim (github_<tool> → mcp_github_<tool>
                        for the dashboard tool-family classifier).
    profiles.ts         ExecutorConfig / ExecutionResult / GitSandboxAccess
                        types + GITHUB_PERMISSION_PROFILES + loadAgentContext.
                        Imported by runner.ts, chat.ts, opencode-executor.ts.
    llm.ts              One-shot LLM helper for screen.ts + classifier.ts —
                        direct fetch to Anthropic Messages or OpenAI Chat
                        Completions based on the model id prefix.
    screen.ts           Prompt-injection screener. Uses llm.ts with a cheap
                        model (claude-haiku by default).
    classifier.ts       Tiny LLM call that decides "is this comment asking
                        me to build something?". Uses llm.ts.
    git-auth.ts         GitHub App JWT → installation token. Supports
                        permission downscoping (contents/issues/pull_requests/
                        metadata read vs write) and a per-token repo allowlist.
    github.ts           Harness-side Octokit client (post comments, create
                        issues, react to comments). Not used by agents.
  workflows/            See src/workflows/CLAUDE.md for the full runner
                        story. Loads YAML definitions, executes phases
                        (linear or DAG), manages resume, approval gates,
                        loop iterations.
  sandbox/              Docker-based isolation for agent runs. One container
                        per task, mounted data volume, hardened path checks
                        (gitdir mounts validated against sandbox root,
                        taskId traversal rejected).
    egress-allowlist.ts Single source of truth for HTTP egress hosts.
                        GITHUB_HOSTS + PROVIDER_HOSTS + PACKAGE_REGISTRY_HOSTS.
                        Leading-dot entries (e.g. ".github.com") are
                        wildcards matching apex + all subdomains. Both
                        backends import it: gondolin passes the list to
                        agentic-pi's `allowedHttpHosts`; docker generates
                        the nginx ssl_preread + coredns sinkhole configs
                        from it at boot.
    egress-firewall-config.ts
                        Generates nginx-strict.conf / nginx-open.conf /
                        Corefile.strict / Corefile.open + otel-collector.yaml
                        under $STATE_DIR/proxy/ at harness boot. The five
                        services in docker-compose.yml (coredns-strict,
                        coredns-open, nginx-egress-strict,
                        nginx-egress-open, otel-collector) read those files.
                        Sandbox telemetry on the docker backend flows
                        sandbox → otel-collector (internal IP) → real
                        backend, so the strict allowlist needs no collector
                        hosts or non-443 port handling.
  worktree/             Small helper for per-task git worktree setup inside
                        the sandbox. Implementation detail of `sandbox/`.
  admin/                Admin dashboard API (Hono) + SessionReader /
                        ChatSessionReader / auth / Slack OAuth login.
                        SessionReader scans opencode-home/projects/-<cwd>/
                        for sandbox runs; ChatSessionReader is DB-backed
                        and groups by Slack thread.
  state/
    db.ts               SQLite tables: executions, workflow_runs,
                        workflow_approvals, messaging_sessions,
                        messaging_messages, plus daily/hourly stat rollups.
  cron/                 node-cron scheduler. Each tick dispatches a
                        cron-kind workflow via the same runner.

workflows/              YAML workflow definitions consumed by the loader.
                        build.yaml, pr-fix.yaml, pr-review.yaml,
                        issue-triage.yaml, issue-comment.yaml,
                        repo-health.yaml, cron-*.yaml.
workflows/prompts/      Prompt templates referenced from phases via
                        `prompt: prompts/architect.md` etc. Rendered with
                        the template engine in src/workflows/templates.ts.

skills/                 Skill directories — each contains SKILL.md
                        (with `name`/`description` frontmatter) plus
                        optional `scripts/`, `references/`, `assets/`.
                        Phases declare `skills: [a, b]` (or sugar
                        `skill: a`); the runner stages each at
                        `<workspace>/.agents/skills/<name>/` (symlink
                        for gondolin/none, copy for docker) before the
                        agent runs. pi-coding-agent's built-in
                        `.agents/skills/` auto-discovery surfaces them
                        as an XML system-prompt catalogue and the
                        agent reads each SKILL.md on demand via its
                        `read` tool. Chat threads use the same skills
                        in-process via a `read_skill` tool —
                        catalogue built at boot from CHAT_SKILL_NAMES
                        in src/engine/chat-skills.ts.
agent-context/          *.md files concatenated and prepended as AGENTS.md
                        for every agent session — the bot's "personality"
                        plus hard rules. Sandbox entrypoint cats these into
                        $WORKSPACE/AGENTS.md; the chat-server supervisor
                        writes the same content + a chat-persona suffix
                        into its own AGENTS.md.

mcp-github-app/         Standalone MCP server exposing GitHub tools to the
                        agent. Uses the GitHub App installation token by
                        default; falls back to a GITHUB_TOKEN env var only
                        when App env vars are unset (low-trust sandbox
                        fallback). Wired into opencode via mcp.github in
                        deploy/opencode-config.tmpl.json (sandbox) and the
                        chat-server's generated opencode.json.
deploy/                 Docker entrypoints, Caddyfile, systemd helpers.
dashboard/              React+Vite admin SPA, served from /admin at runtime.
```

## Key concepts

- **EventEnvelope** (`src/connectors/types.ts`) — canonical event shape.
  Every connector normalizes to it; the engine only ever sees EventEnvelopes.
- **Workflow** — a YAML file listing phases. The runner knows nothing about
  "build" vs "triage" — it just executes phases in order (or as a DAG). See
  `src/workflows/CLAUDE.md`.
- **Configuration & deployment overlay** (`src/config.ts`, `config/default.yaml`,
  issue #61) — non-secret config (managed repos, routes, models, variants,
  approvals, disables) is loaded at startup from the packaged
  `config/default.yaml`, then an optional `$LASTLIGHT_OVERLAY_DIR/config.yaml`
  is layered on, then legacy env vars override. Maps deep-merge; arrays
  (`managedRepos`, `disabled.*`) replace; secrets stay env-only. The same
  `LASTLIGHT_OVERLAY_DIR` root also overlays assets — `workflows/`,
  `workflows/prompts/`, `skills/`, `agent-context/` — resolved layer-aware by
  `src/workflows/loader.ts` (overlay wins by logical name; built-ins are the
  fallback). The public `config/default.yaml` ships an **empty** `managedRepos`
  list and no private values; `src/managed-repos.ts` reads the effective list
  via `getManagedRepos()` (runtime config, not a baked constant). In the
  docker-compose stack the deployment folder is **`instance/`** (mounted
  read-only at `/app/instance`), holding `config.yaml` + asset overrides + a
  gitignored `secrets/` subdir (`.env`, `*.pem`). It's never baked into the
  image — edit it and `docker compose restart agent` to apply, no rebuild. The
  dashboard `/config` endpoint surfaces Default / Overlay / Merged (non-secret).
- **Two execution modes**:
  - **Sandbox** — workflow phases run inside a Docker sandbox
    (`src/sandbox`) with a minted per-run GitHub token. Each phase invokes
    `opencode run --format json` in the container and the harness parses
    the streamed events into an ExecutionResult + envelope jsonl. Every
    phase writes an `executions` row.
  - **Chat** — the chat skill (`src/engine/chat.ts`) talks to the
    long-lived `opencode serve` process over HTTP. One OpenCode session
    per messaging thread, resumed across turns. Each turn writes an
    `executions` row (triggerType=`chat`, skill=`chat`,
    triggerId=messaging session id) and the same shim drops a jsonl
    envelope under `opencode-home/projects/-app/`.
- **Two session stores**:
  - **Sandbox sessions** — shim envelope jsonls at
    `$STATE_DIR/opencode-home/projects/-<sanitized-sandbox-cwd>/`
    (currently `-home-agent-workspace`). Read by `SessionReader`.
  - **Chat sessions** — DB-backed (`executions` table grouped by
    `trigger_id` / Slack thread). Read by `ChatSessionReader`; messages
    resolved to the single jsonl owned by `messaging_sessions.agent_session_id`
    under `opencode-home/projects/-app/`.
- **Permission profiles** (`src/engine/profiles.ts`) — each workflow maps to
  a `GitAccessProfile`: `read`, `issues-write`, `review-write`, `repo-write`.
  `runner.ts` picks one per workflow name and `opencode-executor.ts` mints a
  downscoped installation token for the sandbox. Only `repo-write` runs see
  the App PEM; everything else uses a pre-minted scoped token (static-token
  mode in mcp-github-app).
- **Approval gates** — phases can declare `approval_gate: post_architect`.
  When hit, the run persists with `status: paused`, a row in
  `workflow_approvals`, and the user can resolve it via GitHub comment
  (`@last-light approve` / `reject`), Slack slash command (`/approve`,
  `/reject`), or the dashboard. Resume logic is in `src/workflows/resume.ts`
  and is runtime-agnostic — it operates on `ExecutionResult` + DB rows.
- **Sandbox HTTP egress allowlist** — both backends apply a default-deny
  HTTP egress policy. The host list lives in `src/sandbox/egress-allowlist.ts`
  (`GITHUB_HOSTS` + `PROVIDER_HOSTS` + `PACKAGE_REGISTRY_HOSTS`).
  Entries with a leading dot (e.g. `.github.com`) match the apex AND
  every subdomain.
  - **gondolin**: `agent-executor.ts` passes `allowedHttpHosts` to
    agentic-pi's `run()`. The VM's HTTP interceptor 502s anything off-list.
  - **docker** (SNI-peeking firewall, inspired by Vercel Sandbox):
    The harness writes `nginx-strict.conf` / `nginx-open.conf` /
    `Corefile.strict` / `Corefile.open` to `$STATE_DIR/proxy/` at boot.
    Four services in docker-compose.yml — `coredns-strict` (172.30.0.10),
    `coredns-open` (172.30.0.11), `nginx-egress-strict` (172.30.0.20),
    `nginx-egress-open` (172.30.0.21) — implement the firewall. Sandbox
    containers spawn with `--dns <coredns-ip>` and **no proxy env vars
    at all**. The sandbox dials real hostnames; coredns sinkholes
    allowlisted ones to the nginx IP; nginx peeks the TLS SNI and
    tunnels to the real upstream via `proxy-egress`. This works for
    every SDK regardless of whether it honours `HTTP(S)_PROXY` (the
    OpenAI/Anthropic SDKs don't, which is why the earlier tinyproxy
    approach failed). See `src/sandbox/egress-firewall-config.ts` for
    the full architecture rationale and `docker-compose.test.ts` for
    the topology contract.
  - **Opting out**: a workflow phase can declare `unrestricted_egress: true`
    in YAML to bypass the allowlist for that phase only. Gondolin then
    receives `["*"]` (wildcard allow-all); docker routes through the
    `coredns-open` + `nginx-egress-open` pair. Use sparingly — for
    phases that need broad web access (e.g. an explore phase searching
    third-party docs).
  - **SSRF floor**: `coredns-open` hard-NXDOMAINs the cloud-metadata
    literals (`169.254.169.254`, `metadata.google.internal`) even in
    unrestricted mode. Strict mode blocks all private destinations
    inherently — anything not in the allowlist resolves to NXDOMAIN.
  - **Caveat (no TLS termination)**: we peek SNI without decrypting,
    so a hostname like `evil.example.com` whose A record points at
    `10.0.0.5` would not be caught by the strict filter — but it would
    never resolve in the first place, since coredns-strict only knows
    the allowlist hosts. In the open mode, the same hostname WOULD
    resolve (to the nginx-open IP) and nginx would tunnel to the
    attacker-controlled host. Closing that requires TLS termination
    (e.g. Envoy + dynamic_forward_proxy with post-resolve IP checks),
    which we haven't pulled in.

## State directory

Everything persistable lives under `$STATE_DIR` (default `./data`, mount as
a Docker volume in production).

```
data/
  lastlight.db              SQLite — executions, workflow_runs,
                            workflow_approvals, messaging_sessions,
                            messaging_messages, plus daily/hourly stat
                            rollups.
  opencode-home/            Shim destination. Its `projects/` subdir is the
                            source of truth for dashboard session reads:
    projects/
      -app/                 Chat sessions (one jsonl per Slack thread,
                            keyed by OpenCode sessionId).
      -home-agent-workspace/  Sandbox sessions (cwd inside the container).
  opencode-serve/           Working dir for the long-lived `opencode serve`
                            chat process — generated opencode.json + AGENTS.md
                            live here.
  sandboxes/                Cloned repos per task (one dir per taskId).
  logs/                     Structured harness logs.
  proxy/                    Generated egress firewall configs (docker
                            backend): nginx-strict.conf, nginx-open.conf,
                            Corefile.strict, Corefile.open, plus
                            otel-collector.yaml (in-network OTEL collector
                            config; mode 0600 — may hold backend auth
                            headers). Regenerated on every harness boot from
                            src/sandbox/egress-firewall-config.ts.
                            Bind-mounted read-only into the coredns + nginx
                            + otel-collector containers.
  secrets/app.pem           Mode-600 copy of the GitHub App PEM. Copied
                            here by deploy/entrypoint.sh so sandbox
                            containers can read it via the shared volume
                            (sandbox-entrypoint materializes an
                            agent-readable copy only when ALLOW_APP_PEM=1).
```

## Commands

```bash
# Dev server (webhooks + Slack socket + cron + admin dashboard)
npm run dev              # tsx watch mode
npm run build            # tsc for server
npm run build:dashboard  # vite build for dashboard/
npm start                # compiled JS

# Tests
npx vitest run           # full server suite
cd dashboard && npx tsc -b  # dashboard typecheck

# CLI — thin client that POSTs to a running server
npm run cli -- <github-url>            # default: triage the issue (cheap)
npm run cli -- owner/repo#N            # shorthand
npm run cli -- build owner/repo#N      # explicit full build cycle
npm run cli -- triage owner/repo       # repo-wide scan
npm run cli -- review owner/repo       # repo-wide PR scan
npm run cli -- health owner/repo       # weekly health report

# Local dev with Docker sandbox isolation
./scripts/dev-local.sh                 # builds opencode.json + secrets
                                        # then starts harness in watch mode

# Standalone smoke for the opencode-serve supervisor
npx tsx scripts/chat-smoke.mjs         # two-turn HTTP probe against a
                                        # locally-spawned `opencode serve`
```

## Environment

Required:

- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATION_ID`
- `WEBHOOK_SECRET` — must match the GitHub App webhook secret
- One of `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY`
  matching your `OPENCODE_MODEL` (set multiple if `OPENCODE_MODELS` routes
  phases to different providers)

Models:

- `OPENCODE_MODEL` — default model for sandbox + chat
  (default: `openai/gpt-5.5`)
- `OPENCODE_MODELS` — per-task overrides as JSON, e.g.
  `{"architect":"openai/gpt-5.4","triage":"anthropic/claude-haiku-4-5-20251001"}`.
  Keys match phase names or skill types.
- `OPENCODE_VARIANT` — catch-all reasoning-effort default (passed to
  OpenCode as `--variant`). Provider-agnostic; OpenCode translates to
  the right per-provider knob (OpenAI `reasoning_effort`, Anthropic
  thinking budget, etc.). Common values: `minimal`, `medium`, `high`,
  `max`.
- `OPENCODE_VARIANTS` — per-task variant overrides as JSON, same key
  scheme as `OPENCODE_MODELS`. Example:
  `{"architect":"high","reviewer":"high","review":"high","triage":"minimal"}`.
  Phases can also declare `variant: "{{variants.<phase>}}"` in YAML
  for per-phase resolution.

Runtime:

- `PORT` — webhook listener port (default 8644)
- `LASTLIGHT_OVERLAY_DIR` — trusted deployment overlay root (docker-compose
  mounts `instance/` here as `/app/instance`). Layered over
  `config/default.yaml` for config + assets; secrets read from its `secrets/`
  subdir. Read at startup — restart to apply.
- `STATE_DIR` — persistent state dir (default `./data`)
- `DB_PATH` — override SQLite path
- `OPENCODE_HOME_DIR` — override dashboard session-jsonl root
  (default `$STATE_DIR/opencode-home`)
- `OPENCODE_SERVE_PORT` — port for the long-lived chat server
  (default 4096, bound to 127.0.0.1)
- `OPENCODE_SERVE_LOGS=1` — forward serve logs to harness stderr
- `OPENCODE_BIN` — override the opencode binary path (CI/dev)
- `MCP_CONFIG_PATH` — override generated MCP config path

Sandbox egress (docker backend only):

- `LASTLIGHT_SANDBOX_NETWORK` — docker network sandbox containers attach
  to (default: `lastlight_sandbox-egress`). Set to `default` to keep
  containers on the default bridge — only useful when running the harness
  outside docker-compose where the sandbox-egress network doesn't exist.
- `LASTLIGHT_DNS_STRICT` / `LASTLIGHT_DNS_OPEN` — override the IP of the
  coredns sidecar passed to `docker run --dns ...` (defaults: `172.30.0.10`
  and `172.30.0.11`, matching the static IPs in docker-compose.yml).

OpenTelemetry (optional):

- Disabled by default. Enable with `LASTLIGHT_OTEL_ENABLED=true`; standard `OTEL_EXPORTER_OTLP_*`, `OTEL_SERVICE_NAME`, and `OTEL_RESOURCE_ATTRIBUTES` env vars configure exporter endpoints/headers/resources.
- Last Light exports workflow/phase/agent/chat metadata by default. `LASTLIGHT_OTEL_INCLUDE_CONTENT=true` opts into sensitive prompt/message/tool-result content (truncated).
- `LASTLIGHT_OTEL_FORWARD_TO_SANDBOX=true` (default) enables sandbox telemetry. On the **docker** backend, sandboxes export OTLP to an in-network `otel-collector` compose service (static IP `172.30.0.30` on `sandbox-egress`, dual-homed onto `proxy-egress`), which re-exports to the real backend; the sandbox is given only that internal endpoint (`http://172.30.0.30:4318`), never the backend endpoint or `OTEL_EXPORTER_OTLP_HEADERS`. The collector config is generated from the harness OTEL_* env by `writeOtelCollectorConfig` (`src/sandbox/egress-firewall-config.ts`). This is why custom-port/plaintext collectors no longer need firewall changes — the backend hop runs on the collector's trusted outbound leg, not through `ssl_preread`. On **gondolin**/**none** (agentic-pi runs in-process), `OTEL_*` env is forwarded directly and `LASTLIGHT_OTEL_COLLECTOR_HOSTS` (+ parsed endpoint hosts) feed gondolin's egress allowlist.

Web search (optional, opt-in per workflow phase):

- `TAVILY_API_KEY` / `BRAVE_SEARCH_API_KEY` / `EXA_API_KEY` — set any one
  to enable agentic-pi's `web_search` and `web_fetch` tools for phases
  that declare `web_search: true` in their YAML. Provider auto-detected
  from whichever key is present (Tavily > Exa > Brave). Phases without
  the field pass an explicit `webSearch: false` to agentic-pi so they
  ignore these keys — important, since agentic-pi otherwise auto-enables
  whenever any of the three env vars is present in `process.env`.
- Currently only the `explore` workflow's research phases (`read_context`,
  `socratic`, `synthesize`) opt in. Those phases also set
  `unrestricted_egress: true` so provider API calls and any `web_fetch`
  to third-party docs sites flow through the open-mode firewall
  (coredns-open + nginx-egress-open). The `publish` phase declares
  neither — it stays on the strict allowlist for the only repo-write
  moment of the workflow.

Admin dashboard:

- `ADMIN_PASSWORD` — if set, login required
- `ADMIN_SECRET` — HMAC secret for session tokens

Slack (optional):

- `SLACK_BOT_TOKEN` (xoxb-…), `SLACK_APP_TOKEN` (xapp-…) — enables the
  messaging connector + chat skill (also gates the `opencode serve` spawn)
- `SLACK_DELIVERY_CHANNEL` — channel id for cron reports
- `SLACK_ALLOWED_USERS` — comma-separated user ids allowlist
- `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`,
  `SLACK_OAUTH_REDIRECT_URI` — enables "Login with Slack" on the dashboard
  (OIDC via arctic, uses `openid.connect.userInfo`)
- `SLACK_ALLOWED_WORKSPACE` — restrict OAuth login to one team_id / domain

## Deployment

> **When changing Docker configs (`Dockerfile`, `docker-compose.yml`,
> `deploy/entrypoint.sh`, egress/collector generation), verify against the
> actual runtime — not assumptions.** Notably: the entrypoint runs as root but
> `exec gosu lastlight`s the harness, so the Node process (and shared-volume
> files it writes) is owned by `lastlight` (UID-pinned to 10001), not root.
> Confirm UID/ownership/perms and service start by running the real images
> (e.g. a throwaway container reproducing the entrypoint chain), since unit
> tests pass green while the container reality differs.

Production runs on a single host (the production server — connection details
are kept out of this file; see local agent memory) as a **Docker Compose**
stack — *not* the native systemd model described in `deploy/native/README.md`
(that `lastlight.service` is `inactive`; the README is aspirational). The repo
is checked out at **`/home/lastlight/lastlight`** and the private deployment
overlay (`cliftonc/lastlight-instance`) is cloned into
`/home/lastlight/lastlight/instance/` (mounted read-only at `/app/instance`,
holds `config.yaml` + asset overrides + `secrets/.env` + `secrets/*.pem`).

### Redeploy a code change

```bash
ssh <production-server> /home/lastlight/deploy.sh
```

`/home/lastlight/deploy.sh` is the single source of truth. It:

1. `git pull` in `/home/lastlight/lastlight` (this repo, `main`).
2. Pulls/clones the `instance/` overlay as the `lastlight` user (its read-only
   deploy key, `git@github-instance:cliftonc/lastlight-instance.git`) and
   symlinks `instance/docker-compose.override.yml` into the project root.
3. `docker compose build agent sandbox` then `docker compose up -d
   --remove-orphans` (recreates only what changed — the `agent` service plus
   the egress-firewall sidecars).
4. Force-restarts the egress sidecars (`coredns-strict`, `coredns-open`,
   `nginx-egress-strict`, `nginx-egress-open`, and `otel-collector`) so they
   re-read any regenerated nginx/coredns/collector configs.
5. Health-checks `http://127.0.0.1:8644/health`.

So a normal deploy is: **commit + push to `main`, then run `deploy.sh` on the
host.** Code changes (anything under `src/`, `workflows/`, `skills/`,
`agent-context/`, `config/default.yaml`) need the full `deploy.sh` (image
rebuild). Deployment-only config (the `instance/` overlay) can instead be
edited + committed to the `lastlight-instance` repo and applied with just
`docker compose restart agent` — no image rebuild.

### Operate / debug

```bash
ssh <production-server>
cd /home/lastlight/lastlight
docker compose ps                  # service health
docker compose logs -f agent       # live harness logs
docker compose restart agent       # restart after an instance/ overlay edit
```

## Sub-folder docs

- `src/workflows/CLAUDE.md` — runner internals: phase types, linear vs DAG,
  loop iteration naming (`reviewer_2`, `reviewer_fix_1`), approval gates,
  resume semantics, taskId scoping, template rendering.

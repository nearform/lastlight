<p align="center">
  <img src="transparent_clean.png" alt="Last Light" width="200" />
</p>

<h1 align="center">Last Light</h1>

<p align="center">
  <strong>GitHub Repository Maintenance Agent</strong><br/>
  <a href="https://lastlight.dev">lastlight.dev</a> · <a href="https://github.com/users/cliftonc/projects/4">Roadmap</a>
</p>

An AI agent that maintains GitHub repositories: triaging issues, reviewing PRs, monitoring repo health, and building features through an Architect → Executor → Reviewer development cycle.

Built on [agentic-pi](https://github.com/cliftonc/agentic-pi) (workflow phases) and [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) (in-process chat) with a lightweight TypeScript harness for webhook ingestion, cron scheduling, and process management. Provider-agnostic — point `LASTLIGHT_MODEL` at any `provider/model` pi-ai supports (defaults to `anthropic/claude-sonnet-4-6`).

## Production Setup (Clean Server)

The fastest way to go from a bare server to a running Last Light instance:

```bash
npx lastlight setup
```

The setup wizard walks you through:

1. **GitHub App** — enter your App ID, Installation ID, and PEM key path
2. **Domain & TLS** — optional Caddy config for automatic HTTPS
3. **Managed repositories** — the `owner/repo` list the bot operates on
4. **Provider API key** — `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and/or `OPENROUTER_API_KEY`,
   whichever your `LASTLIGHT_MODEL` points at
5. **Webhook secret** — auto-generated if you don't have one
6. **Slack** — optional bot token and app token for Slack integration
7. **Admin dashboard** — optional password protection

It scaffolds your private **deployment overlay** at `instance/` — writing
`instance/config.yaml` (your managed repos), `instance/secrets/.env`, and copying
your PEM to `instance/secrets/app.pem` (mode 600) — then offers to build and start
the Docker stack. When it's done you have a running instance ready to receive
webhooks. Everything deployment-specific lives in `instance/`, which is mounted
read-only and never baked into the image; edit it and `docker compose restart agent`
to apply (no rebuild). See [Deployment overlay](#deployment-overlay) for the model.

> **Requires:** Node.js 20+, Docker, and a GitHub App already created
> (see [Create a GitHub App](#1-create-a-github-app) below).

For a Docker-free production install (systemd unit, gondolin sandbox), see [Native deploy](#native-systemd-deploy) below.

---

## Quick Start (Local Dev)

### Prerequisites

- Node.js 20+
- Docker Desktop (or compatible) — only needed for `LASTLIGHT_SANDBOX=docker`; gondolin runs without it on macOS/Linux
- A GitHub App (see [Create a GitHub App](#1-create-a-github-app) below)
- An API key for whichever provider your chosen `LASTLIGHT_MODEL` uses
  (`OPENAI_API_KEY` for openai/…, `ANTHROPIC_API_KEY` for anthropic/…, `OPENROUTER_API_KEY` for openrouter/…)

### Setup

```bash
git clone https://github.com/cliftonc/lastlight.git
cd lastlight
npm install
```

Copy and edit the environment file:

```bash
cp .env.example .env
```

Fill in the required values in `.env`:

```bash
# GitHub App (required)
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=./your-app.private-key.pem
GITHUB_APP_INSTALLATION_ID=789012

# Webhook secret (required for webhook mode)
WEBHOOK_SECRET=your-secret-here

# Model + provider — pick one matching your key
LASTLIGHT_MODEL=anthropic/claude-sonnet-4-6
ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# OPENROUTER_API_KEY=sk-or-...

# Sandbox backend (default: gondolin; alternatives: docker, none)
# LASTLIGHT_SANDBOX=gondolin
```

### Run

`npm run dev` runs the harness on your host. Sandbox mode is selected by `LASTLIGHT_SANDBOX`:

- **`gondolin`** (default) — agentic-pi spawns a per-phase QEMU micro-VM in-process. Uses HVF on macOS, KVM on Linux. No Docker needed.
- **`docker`** — agentic-pi runs inside a per-phase sibling Docker container (the `lastlight-sandbox:latest` image). Requires Docker. Useful for prod-like smoke testing.
- **`none`** — agent runs in-process on your host with no isolation. Dev only — never in production.

The dev script is explicitly safe with your personal config:

| | Touched? |
|---|---|
| `~/.gitconfig` (your identity, credential helper) | ❌ skipped (`LASTLIGHT_LOCAL_DEV=1`) |
| `./data/agent-sessions/` | ✅ project-local; shim envelope jsonls for the dashboard live here |
| `./data/sandbox-data/` | ✅ project-local bind-mount when using `LASTLIGHT_SANDBOX=docker` |
| `./data/lastlight.db`, `./data/sandboxes/`, `./data/logs/` | ✅ project-local state, gitignored |

If you want the Docker sandbox mode locally, build the image once first:

```bash
docker compose --profile build-only build sandbox
```

Then run the harness (server + dashboard, with hot reload):

```bash
npm run dev            # both server and dashboard, concurrent
npm run dev:server     # server only
npm run dev:dashboard  # dashboard only
```

Both server scripts call `scripts/dev-local.sh`, which:
- Verifies the sandbox image exists when `LASTLIGHT_SANDBOX=docker`
- Copies your `GITHUB_APP_PRIVATE_KEY_PATH` into `./data/sandbox-data/secrets/app.pem` (mode 600) so the sandbox can authenticate to GitHub
- Sets `LASTLIGHT_LOCAL_DEV=1`, `STATE_DIR=./data`, `LASTLIGHT_SESSIONS_DIR=./data/agent-sessions`
- Starts the harness with `tsx watch src/index.ts`

#### Triggering work via the CLI

The CLI talks to the running server — it does not execute agents directly. Start the server first, then in another terminal:

```bash
# Cheap, safe defaults — single agent invocation
npx tsx src/cli.ts owner/repo#42                                # triage that one issue
npx tsx src/cli.ts https://github.com/owner/repo/issues/42      # same, full URL form
npx tsx src/cli.ts https://github.com/owner/repo/pull/99        # review that one PR
npx tsx src/cli.ts triage owner/repo                            # scan repo for new issues to triage
npx tsx src/cli.ts review owner/repo                            # scan repo for PRs to review
npx tsx src/cli.ts health owner/repo                            # weekly health report

# Expensive, opt-in — full Architect → Executor → Reviewer → PR cycle
npx tsx src/cli.ts build owner/repo#42
npx tsx src/cli.ts build https://github.com/owner/repo/issues/42
```

The default for a single-issue/PR shorthand is the **cheap** action (triage or review). Build cycles require the explicit `build` subcommand to opt in.

### Authentication

pi-ai picks credentials from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and/or `OPENROUTER_API_KEY` on the harness env. The harness forwards them into each sandbox container (or VM) so workflow runs can reach the API.

---

## Docker Deployment

The docker-compose stack is useful when you want a single `docker compose up -d` deploy. For gondolin (and a smaller deployment surface area), prefer the [native systemd deploy](#native-systemd-deploy) instead.

### Build and Run

Build both the harness image **and** the sandbox image. The sandbox image is what the harness spawns per phase when `LASTLIGHT_SANDBOX=docker`. The sandbox service is under the `build-only` profile so it is never started — it is only built.

```bash
docker compose build agent
docker compose --profile build-only build sandbox
docker compose up -d agent
```

Set `LASTLIGHT_SANDBOX=docker` in your `.env`. (Inside the harness container, gondolin's QEMU path isn't available unless you do the nested-virt setup yourself — the docker-sandbox path is the practical default for Docker deployments.)

### Deployment overlay

Everything specific to your deployment — managed repos, model/route/approval
overrides, agent-context, secrets — lives in a single **`instance/`** folder
next to `docker-compose.yml`. It's mounted read-only at `/app/instance`
(`LASTLIGHT_OVERLAY_DIR=/app/instance`) and is **never committed to the public
repo or baked into the image**, so it's the natural home for a private config
repo.

```text
instance/
  config.yaml            # overlay config — merged over the public config/default.yaml
  agent-context/*.md     # (optional) persona/rules overrides, merged by filename
  workflows/*.yaml       # (optional) add or replace workflows by logical name
  skills/<name>/SKILL.md # (optional) skill overrides
  secrets/               # host-only, gitignored: .env + GitHub App *.pem
    .env
    app.pem
```

`npx lastlight setup` scaffolds this for you. To do it by hand (or to clone a
private overlay repo into place):

```bash
mkdir -p instance/secrets
cp deploy/.env.production.example instance/secrets/.env   # then fill it in
cp your-app.private-key.pem instance/secrets/app.pem
chmod 600 instance/secrets/.env instance/secrets/app.pem
# instance/config.yaml — at minimum your managed repos:
printf 'managedRepos:\n  - your-org/repo-one\n' > instance/config.yaml
```

Both the `agent` and `caddy` services read `instance/secrets/.env` via
`env_file`, and the entrypoint also sources it inside the container — so **no
repo-root `.env` is needed**. Merge rules: maps (`models`, `variants`, `routes`,
`approval`) deep-merge over the public defaults; arrays (`managedRepos`,
`disabled.*`) replace; environment variables override both. Overlay files are
read at startup — edit and `docker compose restart agent` to apply, no rebuild.
The dashboard **Config** tab shows Default / Overlay / Merged (non-secret) config
(secret-looking keys are redacted, so a stray secret in `config.yaml` won't leak).

Startup is **fail-fast**: if `LASTLIGHT_OVERLAY_DIR` is set but the folder is
missing or empty (the common "forgot to populate `instance/`" case), or a cron
targets a missing workflow, or a phase's prompt/skill can't resolve, the harness
exits `78` with a clear message instead of booting a broken instance.

### Expose Webhooks

To receive GitHub webhooks, the server needs to be publicly reachable. The included Caddy config handles HTTPS — set `DOMAIN` in `instance/secrets/.env`:

```bash
# In instance/secrets/.env:
#   DOMAIN=lastlight.example.com

# Start both agent and caddy
docker compose up -d
```

Or use [ngrok](https://ngrok.com) / [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) for testing.

### State & Monitoring

All persistent state lives in a single Docker volume (`agent-data`), mounted at `/app/data`:

```
data/
  lastlight.db              # SQLite: executions, workflow_runs, approvals, messaging sessions
  agent-sessions/           # Dashboard JSONL envelope store (written by event-shim.ts)
    projects/-app/*.jsonl                    # Chat sessions (one per Slack thread)
    projects/-home-agent-workspace/*.jsonl   # Sandbox-mode workflow sessions
  sandboxes/                # Cloned repos per task (gondolin or docker)
  sandbox-data/             # Shared volume mounted into docker-mode sandboxes
  logs/                     # Structured logs
  secrets/app.pem           # GitHub App PEM (mode 600) for sandbox access
```

Mount this volume or bind-mount the directory for monitoring tools to access session logs and the execution database.

### Trigger Work via CLI

With the container running:

```bash
# Health check
curl http://localhost:8644/health

# Trigger a build cycle
npx tsx src/cli.ts https://github.com/owner/repo/issues/42

# Trigger triage
npx tsx src/cli.ts triage owner/repo
```

---

## Native (systemd) Deploy

For a Linux production host with KVM available (`/dev/kvm`), the native deploy runs the harness directly under systemd and uses gondolin for sandboxing — no Docker required.

See [deploy/native/README.md](deploy/native/README.md) for the full runbook. The short version:

```bash
git clone https://github.com/cliftonc/lastlight.git /opt/lastlight
cd /opt/lastlight
# (optional) install -m 0600 -o root /path/to/app.pem /etc/lastlight/app.pem
sudo bash deploy/native/install.sh        # scaffolds /etc/lastlight/lastlight.env
sudo $EDITOR /etc/lastlight/lastlight.env # fill in secrets
sudo bash deploy/native/install.sh        # second run: starts the service
```

Re-deploys: `git pull && sudo bash deploy/native/install.sh` (idempotent — rebuilds and restarts the service).

**Required:** the host kernel must expose `/dev/kvm` (bare-metal Linux or KVM-enabled VM). Hetzner Cloud, Cloud Run, Fly Machines (without `--vm-cpu-class shared`), and most managed container hosts do **not** expose nested virt — see `agentic-pi`'s `SPIKE-gondolin.md` for the full constraint matrix.

If KVM isn't available, fall back to the Docker deploy above with `LASTLIGHT_SANDBOX=docker`.

---

## Setup Details

### 1. Create a GitHub App

1. Go to **https://github.com/settings/apps/new**
2. Fill in:
   - **Name**: your bot name (appears on comments/PRs with a `[bot]` badge)
   - **Homepage URL**: your repo URL
   - **Webhook URL**: `https://your-domain:8644/webhooks/github` (or leave blank for now)
   - **Webhook Secret**: a random string (same as `WEBHOOK_SECRET` in `.env`)
3. Set **permissions**:
   - **Issues**: Read & Write
   - **Pull Requests**: Read & Write
   - **Contents**: Read & Write
   - **Metadata**: Read
4. Subscribe to **events**: `Issues`, `Pull request`, `Issue comment`
5. Click **Create GitHub App**
6. Click **Generate a private key** — save the `.pem` file into the project directory
7. Note the **App ID** from the app settings page
8. Click **Install App** → install on your repos
9. Note the **Installation ID** from the URL: `github.com/settings/installations/{ID}`

### 2. Environment Variables

Legacy `OPENCODE_*` names are still read as fallbacks for the corresponding `LASTLIGHT_*` names, so existing `.env` files from the OpenCode era keep working.

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_APP_ID` | Yes | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Yes | Path to `.pem` file |
| `GITHUB_APP_INSTALLATION_ID` | Yes | Installation ID |
| `WEBHOOK_SECRET` | Yes | GitHub webhook signature secret |
| `OPENAI_API_KEY` | One of | API key when using `openai/…` models |
| `ANTHROPIC_API_KEY` | One of | API key when using `anthropic/…` models |
| `OPENROUTER_API_KEY` | One of | API key when using `openrouter/…` models |
| `LASTLIGHT_OVERLAY_DIR` | No | Trusted deployment overlay directory (the docker-compose stack mounts `instance/` here as `/app/instance`). Startup loads `config/default.yaml`, optional `$LASTLIGHT_OVERLAY_DIR/config.yaml`, then env overrides; overlay assets under `workflows/`, `workflows/prompts/`, `skills/`, and `agent-context/` replace built-ins. Secrets live in `$LASTLIGHT_OVERLAY_DIR/secrets/`. Restart required after changes. See [Deployment overlay](#deployment-overlay). |
| `LASTLIGHT_MODEL` | No | Default model (default: `anthropic/claude-sonnet-4-6`). Legacy: `OPENCODE_MODEL`. |
| `LASTLIGHT_MODELS` | No | Per-task model overrides as JSON, e.g. `{"chat":"openai/gpt-5.1-mini","architect":"openai/gpt-5.5"}`. Legacy: `OPENCODE_MODELS`. |
| `LASTLIGHT_THINKING` | No | Reasoning-effort default (`off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh`). pi-ai translates per-provider. Legacy: `OPENCODE_VARIANT`. |
| `LASTLIGHT_THINKINGS` | No | Per-task thinking-level overrides as JSON, e.g. `{"architect":"high","reviewer":"high","triage":"minimal"}`. Legacy: `OPENCODE_VARIANTS`. |
| `LASTLIGHT_SANDBOX` | No | Workflow sandbox backend: `gondolin` (default) \| `docker` \| `none`. |
| `LASTLIGHT_SESSIONS_DIR` | No | Where the dashboard reads sessions (default: `$STATE_DIR/agent-sessions`). |
| `PORT` / `WEBHOOK_PORT` | No | Webhook listener port (default: `8644`) |
| `STATE_DIR` | No | Persistent state directory (default: `./data`) |
| `DB_PATH` | No | SQLite path (default: `$STATE_DIR/lastlight.db`) |
| `MAX_TURNS` | No | Reserved (kept for API stability) |
| `BOT_LOGIN` | No | Bot login name for self-event filtering (default: `last-light[bot]`) |
| `LASTLIGHT_LOCAL_DEV` | No | Set to `1` on dev machines to skip `git config --global` writes from `git-auth.ts`. The installation token still reaches sandboxes via `GIT_TOKEN`. |
| `SANDBOX_DATA_VOLUME` | No | Used only when `LASTLIGHT_SANDBOX=docker`. Either a Docker named volume (default: `lastlight_agent-data`) or a host path (`/`, `./`, `../`, `~`) to bind-mount as `/data` inside each sandbox. Local dev uses `./data/sandbox-data`. |

### 3. Managed Repositories

The public `config/default.yaml` ships an **empty** `managedRepos` list — set
yours in the overlay (`instance/config.yaml`), which replaces the list wholesale:

```yaml
managedRepos:
  - your-org/repo-one
  - your-org/repo-two
```

Webhooks for repos not in this list are filtered at the connector level; Slack/CLI
commands targeting unmanaged repos are rejected. Install the GitHub App on each.

### 4. Customize Behaviour

Put deployment-specific changes in your overlay (`instance/`) instead of editing
packaged files — that keeps your config out of the public repo and applies on a
restart (no rebuild). See [Deployment overlay](#deployment-overlay) for the full
model and layout.

```text
instance/
  config.yaml                 # non-secret config overrides only
  workflows/*.yaml            # add/replace workflows by logical `name`
  workflows/prompts/*.md      # prompt overrides/fallbacks
  skills/<name>/SKILL.md      # skill overrides/fallbacks
  agent-context/*.md          # merged by filename; overlay replaces built-ins
  secrets/                    # host-only, gitignored: .env + *.pem
```

The dashboard Config tab shows Default / Overlay / Merged non-secret config.
Overlay files are read at startup only; `docker compose restart agent` after changes.

| What | Where |
|------|-------|
| Managed repos, routes, models, variants, approvals, disables | overlay `instance/config.yaml` (over `config/default.yaml`) |
| Bot personality & communication style | `agent-context/soul.md` or overlay `instance/agent-context/` |
| Operational rules, review guidelines, triage rules | `agent-context/rules.md` or overlay `instance/agent-context/` |
| Skill definitions | `skills/*/SKILL.md` or overlay `instance/skills/` |
| Workflow phases (Architect/Executor/Reviewer/PR) | `workflows/*.yaml` + `workflows/prompts/` or overlay equivalents |
| Cron job schedules | `workflows/cron-*.yaml` or overlay workflows |

---

## Architecture

```
┌─────────────────────────────────────────┐
│            Connector Layer              │
│  GitHub Webhook │ Slack Socket Mode     │
│        ↓        │         ↓             │
│     Event Normalizer (EventEnvelope)    │
└────────────────┬────────────────────────┘
                 ↓
┌─────────────────────────────────────────┐
│             Core Engine                 │
│  Event Router (deterministic)           │
│        ↓                                │
│  Workflow Runner (YAML phases)          │
│  - Sandbox: `agentic-pi run` per phase  │
│    in a gondolin VM or docker container │
│  - Chat: in-process pi-ai loop          │
│    one session per messaging thread     │
│        ↓                                │
│  Sandboxes (git clone per task)         │
│  Cron Scheduler (health reports)        │
│  State DB (SQLite execution log)        │
└─────────────────────────────────────────┘
```

### How Events Flow

1. **GitHub webhook** → connector verifies signature, filters noise (bot events, edits, labels), normalizes to `EventEnvelope`
2. **Router** maps event type to skill deterministically (no LLM in the routing loop):
   - `issue.opened` → `issue-triage`
   - `pr.opened` → `pr-review`
   - `comment.created` with `@last-light` from a maintainer → routed by intent classifier (build / explore / triage / review / action)
3. **Workflow runner** loads the matching YAML, dispatches each phase to `executeAgent` (`src/engine/agent-executor.ts`, which invokes agentic-pi) or, for chat, `ChatRunner` (`src/engine/chat-runner.ts`, in-process pi-ai)
4. **Build workflow** runs a multi-phase cycle:
   - Phase 1: **Architect** — read-only analysis, writes plan to `.lastlight/issue-N/architect-plan.md`
   - Phase 2: **Executor** — TDD implementation following the plan
   - Phase 3: **Reviewer** — independent verification (no shared context with executor)
   - Phase 4: **Fix loop** (up to 2 cycles if reviewer requests changes)
   - Phase 5: **Create PR**

### Cron

When webhooks are enabled, only the weekly health report runs on cron (issue/PR events arrive in real-time via webhooks). Without webhooks, triage and PR review also run on cron.

| Job | Schedule | Condition |
|-----|----------|-----------|
| Triage new issues | Every 15 min | Only without webhooks |
| Check PRs for review | Every 30 min | Only without webhooks |
| Weekly health report | Mondays 9am | Always |

---

## Project Structure

```
lastlight/
  src/
    index.ts                # Server entry point
    cli.ts                  # CLI client (talks to server)
    config.ts               # Config loader (.env)
    connectors/
      types.ts              # Connector + EventEnvelope interfaces
      github-webhook.ts     # GitHub webhook connector (Hono)
      index.ts              # Connector registry
    engine/
      router.ts             # Deterministic event → skill routing
      agent-executor.ts     # Workflow phase runner: invokes agentic-pi
                            #   (gondolin / docker / none backends)
      chat-runner.ts        # In-process pi-ai chat loop; one session per
                            #   Slack/Discord thread, rehydrated from DB
      chat.ts               # Chat skill (delegates to ChatRunner)
      github-tools.ts       # Read-only GitHub tools surfaced to chat
      event-shim.ts         # Translates agentic-pi events → Claude-SDK
                            #   envelope jsonl for the dashboard reader
      profiles.ts           # ExecutorConfig / ExecutionResult types +
                            #   GITHUB_PERMISSION_PROFILES + loadAgentContext
      llm.ts                # One-shot LLM helper for screen + classifier
      screen.ts             # Prompt-injection screener
      classifier.ts         # Intent classifier (build / explore / triage / …)
      git-auth.ts           # GitHub App git credential setup
      github.ts             # Harness-side Octokit client (comments, etc.)
    workflows/              # YAML workflow runner (see src/workflows/CLAUDE.md)
    sandbox/                # Per-task workspace + docker-sandbox lifecycle
    cron/
      scheduler.ts          # Cron with overlap protection
      jobs.ts               # Cron job registry
    admin/                  # Dashboard API (Hono) + session readers
    state/
      db.ts                 # SQLite execution tracking

  agent-context/
    soul.md                 # Bot personality, principles, communication style
    rules.md                # Operational rules, managed repos, review guidelines

  skills/
    github-orchestrator/    # Central build cycle coordinator
    issue-triage/           # Issue labeling and triage
    pr-review/              # Structured PR review
    repo-health/            # Health reports
    github/                 # GitHub API workflow skills
    software-development/   # Dev skills (architect, TDD, debugging)

  workflows/                # YAML workflow definitions
    build.yaml              # Architect → Executor → Reviewer → PR
    issue-triage.yaml
    pr-review.yaml
    repo-health.yaml
    cron-*.yaml             # Cron-kind triggers
    prompts/                # Per-phase prompt templates

  deploy/
    entrypoint.sh           # Docker entrypoint (harness container)
    sandbox-entrypoint.sh   # Sandbox container entrypoint (docker-sandbox mode)
    native/                 # Native (systemd) deploy artifacts
      lastlight.service     # systemd unit
      install.sh            # Idempotent provision + redeploy script
      lastlight.env.example # Env template for /etc/lastlight/lastlight.env
      README.md             # Native-deploy operator runbook
  Dockerfile                # Harness image (test-only; prod uses native deploy)
  sandbox.Dockerfile        # Sandbox image for LASTLIGHT_SANDBOX=docker
  docker-compose.yml
  Caddyfile                 # Reverse proxy for HTTPS
```

## Troubleshooting

### Server won't start

```bash
# Check .env is loaded
npm run dev:server
# Look for "Required environment variable not set" errors
```

### `npm run dev` says the sandbox image is missing (docker-sandbox mode)

```bash
docker compose --profile build-only build sandbox
```

### Workflow run fails with `exit 127: sh: 1: agentic-pi: not found`

The sandbox image needs `agentic-pi` baked in. Rebuild it:

```bash
docker compose --profile build-only build sandbox
```

If you're on an old `lastlight-sandbox:latest`, this picks up the install step that the current `sandbox.Dockerfile` performs.

### Workflow hangs forever with no output (gondolin mode on a host without KVM)

Gondolin requires `/dev/kvm` on Linux or HVF on macOS. Inside a container with no nested virt, `VM.create()` succeeds but the first `vm.exec()` hangs. Symptoms: phase shows "running" indefinitely with no JSONL events after `sandbox_status`.

Either switch to `LASTLIGHT_SANDBOX=docker` (sibling containers via socket) or move the harness to a KVM-capable host. Full analysis: `agentic-pi/SPIKE-gondolin.md`.

### Agent run fails with a quota / billing error

The runtime surfaces upstream errors as `error_api` with the verbatim provider message in the executions row:

- OpenAI: "Quota exceeded. Check your plan and billing details." → top up at https://platform.openai.com/account/billing
- Anthropic: "Credit balance is too low" → top up at https://console.anthropic.com

### Chat replies fail with `error_error`

Check the agent logs for the underlying error — common causes:

- **Wrong key for the chat model.** `LASTLIGHT_MODELS={"chat":"anthropic/…"}` but no `ANTHROPIC_API_KEY` set. Fix the override or add the key.
- **Model id typo.** Watch for `[config] Model: …` in startup logs to confirm what's actually loaded.

### Webhooks not arriving

```bash
# Check health endpoint
curl http://localhost:8644/health

# Test with a fake POST (should return 401 — invalid signature)
curl -X POST http://localhost:8644/webhooks/github -d '{}'

# Check Docker port mapping
docker compose ps
```

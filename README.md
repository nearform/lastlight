<p align="center">
  <img src="transparent_clean.png" alt="Last Light" width="200" />
</p>

<h1 align="center">Last Light</h1>

<p align="center">
  <strong>GitHub Repository Maintenance Agent</strong><br/>
  <a href="https://lastlight.dev">lastlight.dev</a> · <a href="https://github.com/orgs/nearform/projects/112">Roadmap</a>
</p>

An AI agent that maintains GitHub repositories: triaging issues, reviewing PRs, monitoring repo health, and building features through an Architect → Executor → Reviewer development cycle.

Built on [agentic-pi](https://github.com/nearform/agentic-pi) (workflow phases) and [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai) (in-process chat) with a lightweight TypeScript harness for webhook ingestion, cron scheduling, and process management. Provider-agnostic — point `LASTLIGHT_MODEL` at any `provider/model` pi-ai supports (defaults to `anthropic/claude-sonnet-4-6`).

## Monorepo layout

This repository is a **pnpm + Turborepo** workspace. The harness/server internals
now live under `apps/server/` (formerly the repo root). At a glance:

```
apps/
  server/   @lastlight/core  — the harness + server (src, config, workflows,
                               skills, agent-context, deploy, dashboard, spec, …)
  www/      lastlight-www     — the Astro marketing/docs site → lastlight.dev
  evals/    lastlight-evals   — the eval harness → evals.lastlight.dev
packages/
  cli/               lastlight              — the lean, published global CLI (+ the Claude Code plugin)
  shared/            @lastlight/shared      — shared utilities (e.g. the provider registry)
  workflow-engine/   @lastlight/workflow-engine — the reusable workflow runner
```

Five packages publish to npm: `lastlight`, `@lastlight/core`,
`@lastlight/workflow-engine`, `@lastlight/shared`, and `lastlight-evals`. The
root package (`lastlight-monorepo`) is private. Common scripts run from the root
via Turborepo: `pnpm build` / `pnpm test` / `pnpm typecheck` (each `turbo run …`),
and `pnpm dev` (= `pnpm --filter @lastlight/core dev`). See the root `CLAUDE.md`
for the canonical workspace map and orientation.

## Production Setup (Clean Server)

The fastest way to go from a bare server to a running Last Light instance:

```bash
npx lastlight setup
```

The setup wizard walks you through:

1. **GitHub App** — enter your App ID, Installation ID, and PEM key path
2. **Domain & TLS** — optional Caddy config for automatic HTTPS
3. **Managed repositories** — the `owner/repo` list the bot operates on
4. **Model provider + API key** — pick from any of pi-ai's 15+ supported
   providers (Anthropic, OpenAI, Google Gemini, Mistral, Groq, Cerebras, xAI,
   Hugging Face, Moonshot, NVIDIA, Fireworks, Together, DeepSeek, Z.AI,
   Kimi for Coding, MiniMax, OpenRouter), then enter the model id and the
   matching API key. See `packages/shared/src/providers.ts` for the full registry.
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
- An API key for whichever provider your chosen `LASTLIGHT_MODEL` uses.
  The wizard surfaces pi-ai's 15+ providers — see `packages/shared/src/providers.ts` for the
  full registry (e.g. `ANTHROPIC_API_KEY` for anthropic/…, `OPENAI_API_KEY`
  for openai/…, `GROQ_API_KEY` for groq/…, `GEMINI_API_KEY` for google/…,
  `OPENROUTER_API_KEY` for the openrouter/… aggregator).

### Setup

```bash
git clone https://github.com/nearform/lastlight.git
cd lastlight
pnpm install          # this is a pnpm workspace — installs every package
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

# Model + provider — the wizard surfaces pi-ai's 15+ providers. The
# registry lives in packages/shared/src/providers.ts; pick any `provider/model` it lists.
LASTLIGHT_MODEL=anthropic/claude-sonnet-4-6
ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
# OPENROUTER_API_KEY=sk-or-...
# GROQ_API_KEY=gsk_...      GEMINI_API_KEY=AIza...   HF_TOKEN=hf_...
# XAI_API_KEY=...
# ZAI_API_KEY=...        MISTRAL_API_KEY=...    FIREWORKS_API_KEY=...

# Sandbox backend (default: gondolin; alternatives: docker, none)
# LASTLIGHT_SANDBOX=gondolin
```

### Run

`pnpm --filter @lastlight/core dev` runs the harness on your host. Sandbox mode is selected by `LASTLIGHT_SANDBOX`:

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
docker compose --profile build-only build sandbox-base   # shared base first
docker compose --profile build-only build sandbox
```

Then run the harness (server + dashboard, with hot reload). These scripts live
in the `@lastlight/core` package (`apps/server/`); run them with `pnpm --filter`
from anywhere in the repo:

```bash
pnpm --filter @lastlight/core dev            # both server and dashboard, concurrent
pnpm --filter @lastlight/core dev:server     # server only
pnpm --filter @lastlight/core dev:dashboard  # dashboard only
```

Both server scripts call `apps/server/scripts/dev-local.sh`, which:
- Verifies the sandbox image exists when `LASTLIGHT_SANDBOX=docker`
- Copies your `GITHUB_APP_PRIVATE_KEY_PATH` into `./data/sandbox-data/secrets/app.pem` (mode 600) so the sandbox can authenticate to GitHub
- Sets `LASTLIGHT_LOCAL_DEV=1`, `STATE_DIR=./data`, `LASTLIGHT_SESSIONS_DIR=./data/agent-sessions`
- Starts the harness with `tsx watch src/index.ts` (cwd is `apps/server/`)

#### Triggering work via the CLI

The CLI talks to the running server — it does not execute agents directly. The
CLI source lives in the `lastlight` package (`packages/cli/`, entry `src/cli.ts`);
from a checkout run it via `pnpm --filter lastlight exec tsx src/cli.ts`. Start
the server first, then in another terminal:

```bash
# Cheap, safe defaults — single agent invocation
pnpm --filter lastlight exec tsx src/cli.ts owner/repo#42                            # triage that one issue
pnpm --filter lastlight exec tsx src/cli.ts https://github.com/owner/repo/issues/42  # same, full URL form
pnpm --filter lastlight exec tsx src/cli.ts https://github.com/owner/repo/pull/99    # review that one PR
pnpm --filter lastlight exec tsx src/cli.ts triage owner/repo                        # scan repo for new issues to triage
pnpm --filter lastlight exec tsx src/cli.ts review owner/repo                        # scan repo for PRs to review
pnpm --filter lastlight exec tsx src/cli.ts health owner/repo                        # weekly health report

# Expensive, opt-in — full Architect → Executor → Reviewer → PR cycle
pnpm --filter lastlight exec tsx src/cli.ts build owner/repo#42
pnpm --filter lastlight exec tsx src/cli.ts build https://github.com/owner/repo/issues/42
```

> Installed globally, these are just `lastlight owner/repo#42` etc. — the
> subcommands are identical.

The default for a single-issue/PR shorthand is the **cheap** action (triage or review). Build cycles require the explicit `build` subcommand to opt in.

### Authentication

pi-ai picks credentials from the provider env vars the harness forwards (the full listed set lives in `packages/shared/src/providers.ts` — Anthropic / OpenAI / OpenRouter / Google / Mistral / Groq / Cerebras / xAI / HuggingFace / Moonshot / NVIDIA / Fireworks / Together / DeepSeek / Z.AI / Kimi / MiniMax). The harness forwards them into each sandbox container (or VM) so workflow runs can reach the API.

#### Subscription logins (OAuth) — Codex, Claude Pro, Copilot

Instead of an API key you can authenticate with a paid subscription. pi-ai
supports three OAuth providers; log in once on the host and Last Light stores
and refreshes the token for you. In this from-source checkout the CLI runs via
`tsx` from the `lastlight` package (`packages/cli/`); installed globally, `npm i
-g lastlight` gives you the same `lastlight oauth …` commands:

```bash
pnpm --filter lastlight exec tsx src/cli.ts oauth login openai-codex   # ChatGPT Plus/Pro (Codex)
pnpm --filter lastlight exec tsx src/cli.ts oauth login anthropic      # Claude Pro/Max
pnpm --filter lastlight exec tsx src/cli.ts oauth login github-copilot # GitHub Copilot
pnpm --filter lastlight exec tsx src/cli.ts oauth list                 # providers + who's logged in
pnpm --filter lastlight exec tsx src/cli.ts oauth status               # store path + token expiry
pnpm --filter lastlight exec tsx src/cli.ts oauth test openai-codex    # verify a stored login refreshes
pnpm --filter lastlight exec tsx src/cli.ts oauth logout [provider]    # remove one (or all)
```

> Installed globally, these are just `lastlight oauth login …` etc. — the
> subcommands are identical.

Then point the model at that provider and restart the agent:

```bash
LASTLIGHT_MODEL=openai-codex/gpt-5.5   # Codex ids: gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex-spark
```

The login writes `auth.json` under `$STATE_DIR` (same JSON shape pi-ai's own
`npx @earendil-works/pi-ai login` writes; override with `LASTLIGHT_AUTH_FILE`).
It's **host-local** — the browser OAuth flow runs where you type the command,
so run it on the machine that runs the agent, then restart (`pnpm --filter
@lastlight/core dev:server` from source, or `lastlight server restart agent` for the installed deploy) to
pick it up. Note `tsx watch` does **not** reload on `.env` changes — restart
after switching `LASTLIGHT_MODEL`.

**Reach differs by execution path.** The in-process **chat** path passes the
token as a per-call key, so all three providers work there. The **sandbox**
(agentic-pi workflow phases) resolves credentials from env only —
`ANTHROPIC_OAUTH_TOKEN` / `COPILOT_GITHUB_TOKEN` cover Anthropic and Copilot,
but **Codex has no env-token route and therefore can't run sandbox workflows**
(it's chat-only). Use an API-key provider for build/triage/review workflows if
you only have a Codex subscription.

---

## Docker Deployment

The docker-compose stack is useful when you want a single `docker compose up -d` deploy. For gondolin (and a smaller deployment surface area), prefer the [native systemd deploy](#native-systemd-deploy) instead.

### Build and Run

Build both the harness image **and** the sandbox image. The sandbox image is what the harness spawns per phase when `LASTLIGHT_SANDBOX=docker`. The sandbox service is under the `build-only` profile so it is never started — it is only built.

```bash
docker compose build agent
docker compose --profile build-only build sandbox-base   # shared base first
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

Both `npx lastlight setup` (the config wizard) and `lastlight server setup`
scaffold this for you and then offer to **version it as a private repo** —
`git init` + an initial commit, then `gh repo create … --private --push` when
the GitHub CLI is authenticated, or the exact git/GitHub commands to run by hand
otherwise. `server setup` also lets you point at an existing overlay repo to
clone instead. To do it fully by hand:

```bash
mkdir -p instance/secrets
cp apps/server/deploy/.env.production.example instance/secrets/.env   # then fill it in
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

# Trigger a build cycle (or just `lastlight …` with the installed CLI)
pnpm --filter lastlight exec tsx src/cli.ts https://github.com/owner/repo/issues/42

# Trigger triage
pnpm --filter lastlight exec tsx src/cli.ts triage owner/repo
```

---

## Native (systemd) Deploy

For a Linux production host with KVM available (`/dev/kvm`), the native deploy runs the harness directly under systemd and uses gondolin for sandboxing — no Docker required.

See [apps/server/deploy/native/README.md](apps/server/deploy/native/README.md) for the full runbook. The short version:

```bash
git clone https://github.com/nearform/lastlight.git /opt/lastlight
cd /opt/lastlight/apps/server
# (optional) install -m 0600 -o root /path/to/app.pem /etc/lastlight/app.pem
sudo bash deploy/native/install.sh        # scaffolds /etc/lastlight/lastlight.env
sudo $EDITOR /etc/lastlight/lastlight.env # fill in secrets
sudo bash deploy/native/install.sh        # second run: starts the service
```

Re-deploys: `git pull && sudo bash deploy/native/install.sh` (idempotent — rebuilds and restarts the service), from `apps/server/`.

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
   - **Checks**: Read & Write (post the `last-light/review` check; receive its "Re-run" requests)
   - **Metadata**: Read
4. Subscribe to **events**: `Issues`, `Pull request`, `Issue comment`, `Check run`, `Check suite` (the last two enable the GitHub "Re-run checks" buttons to re-trigger a review)
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
| `OPENAI_API_KEY` | One of | API key for an `openai/…` model |
| `ANTHROPIC_API_KEY` | One of | API key for an `anthropic/…` model |
| `OPENROUTER_API_KEY` | One of | API key for the `openrouter/…` aggregator |
| `GEMINI_API_KEY` | One of | API key for a `google/…` model |
| `MISTRAL_API_KEY` | One of | API key for `mistral/…` |
| `GROQ_API_KEY` | One of | API key for `groq/…` |
| `CEREBRAS_API_KEY` | One of | API key for `cerebras/…` |
| `XAI_API_KEY` | One of | API key for `xai/…` (Grok) |
| `HF_TOKEN` | One of | API key for `huggingface/…` |
| `MOONSHOT_API_KEY` | One of | API key for `moonshotai/…` (Kimi) |
| `NVIDIA_API_KEY` | One of | API key for `nvidia/…` |
| `FIREWORKS_API_KEY` | One of | API key for `fireworks/…` |
| `TOGETHER_API_KEY` | One of | API key for `together/…` |
| `DEEPSEEK_API_KEY` | One of | API key for `deepseek/…` |
| `ZAI_API_KEY` | One of | API key for `zai/…` (GLM) |
| `KIMI_API_KEY` | One of | API key for `kimi-coding/…` |
| `MINIMAX_API_KEY` | One of | API key for `minimax/…` |
| _… or any other `provider/model` whose key is forwarded by `packages/shared/src/providers.ts`_ | | The wizard surfaces the registered set; see `packages/shared/src/providers.ts` for the full list. |
| `LASTLIGHT_OVERLAY_DIR` | No | Trusted deployment overlay directory (the docker-compose stack mounts `instance/` here as `/app/instance`). Startup loads `config/default.yaml`, optional `$LASTLIGHT_OVERLAY_DIR/config.yaml`, then env overrides; overlay assets under `workflows/`, `workflows/prompts/`, `skills/`, and `agent-context/` replace built-ins. Secrets live in `$LASTLIGHT_OVERLAY_DIR/secrets/`. Restart required after changes. See [Deployment overlay](#deployment-overlay). |
| `LASTLIGHT_MODEL` | No | Default model (default: `anthropic/claude-sonnet-4-6`). Legacy: `OPENCODE_MODEL`. |
| `LASTLIGHT_MODELS` | No | Per-task model overrides as JSON, e.g. `{"chat":"openai/gpt-5.1-mini","architect":"openai/gpt-5.5"}`. Legacy: `OPENCODE_MODELS`. |
| `LASTLIGHT_THINKING` | No | Reasoning-effort default (`off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh`). pi-ai translates per-provider. Legacy: `OPENCODE_VARIANT`. |
| `LASTLIGHT_THINKINGS` | No | Per-task thinking-level overrides as JSON, e.g. `{"architect":"high","reviewer":"high","triage":"minimal"}`. Legacy: `OPENCODE_VARIANTS`. |
| `LASTLIGHT_SANDBOX` | No | Workflow sandbox backend: `gondolin` (default) \| `docker` \| `none`. |
| `LASTLIGHT_OTEL_ENABLED` | No | Enable OpenTelemetry export (default: `false`). Standard `OTEL_*` env vars alone do not enable telemetry. |
| `LASTLIGHT_OTEL_SERVICE_NAME` | No | OTEL service name (default: `lastlight`; falls back to `OTEL_SERVICE_NAME`). |
| `LASTLIGHT_OTEL_INCLUDE_CONTENT` | No | Include prompts/message/tool-result content in telemetry (default: `false`; sensitive, use carefully). |
| `LASTLIGHT_OTEL_FORWARD_TO_SANDBOX` | No | Forward sandbox telemetry to the backend (default: `true`). On the `docker` backend this routes through an in-network OTEL collector; on `gondolin`/`none` it forwards allowlisted `OTEL_*` env vars directly. |
| `LASTLIGHT_OTEL_STRICT` | No | Throw on OTEL initialization/export setup failure instead of warn-and-continue (default: `false`). |
| `LASTLIGHT_OTEL_COLLECTOR_HOSTS` | No | Comma-separated collector hostnames added to the strict sandbox egress allowlist. Used only by the `gondolin` backend (the `docker` backend reaches its collector internally and ignores this). |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_*_ENDPOINT` | No | Standard OTLP HTTP collector endpoints. Used by the harness directly, and by the in-network collector as its re-export target on the `docker` backend. |
| `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_*_HEADERS` | No | Standard OTLP headers; secret/env-only and never shown in public config. |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | No | Standard OTEL resource configuration. |
| `LASTLIGHT_SESSIONS_DIR` | No | Where the dashboard reads sessions (default: `$STATE_DIR/agent-sessions`). |
| `PORT` / `WEBHOOK_PORT` | No | Webhook listener port (default: `8644`) |
| `STATE_DIR` | No | Persistent state directory (default: `./data`) |
| `DB_PATH` | No | SQLite path (default: `$STATE_DIR/lastlight.db`) |
| `MAX_TURNS` | No | Reserved (kept for API stability) |
| `BOT_LOGIN` | No | Bot login name for self-event filtering (default: `last-light[bot]`) |
| `LASTLIGHT_LOCAL_DEV` | No | Set to `1` on dev machines to skip `git config --global` writes from `git-auth.ts`. The installation token still reaches sandboxes via `GIT_TOKEN`. |
| `SANDBOX_DATA_VOLUME` | No | Used only when `LASTLIGHT_SANDBOX=docker`. Either a Docker named volume (default: `lastlight_agent-data`) or a host path (`/`, `./`, `../`, `~`) to bind-mount as `/data` inside each sandbox. Local dev uses `./data/sandbox-data`. |

### OpenTelemetry export

OpenTelemetry is disabled by default. Set `LASTLIGHT_OTEL_ENABLED=true` and configure standard OTEL exporter env vars such as `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, and `OTEL_RESOURCE_ATTRIBUTES` to export harness spans/metrics for workflow runs, phases, agent executions, PI event streams, and chat turns.

By default Last Light exports metadata only: workflow/phase names, repo, sandbox backend, model, success/stop reason, timing, tokens, and cost. Prompt text, message content, tool arguments, and tool outputs are redacted unless `LASTLIGHT_OTEL_INCLUDE_CONTENT=true`; that opt-in can export sensitive data and should only be used with a trusted collector.

When `LASTLIGHT_OTEL_FORWARD_TO_SANDBOX=true` (default), `agentic-pi` workflow sandboxes emit their own telemetry too. How it reaches the backend depends on the sandbox backend:

- **`docker` (production):** sandboxes export OTLP to an **in-network OTEL collector** (a `otel-collector` compose service on the `sandbox-egress` network, reached by a fixed internal IP). That collector re-exports to your real backend over its own outbound network leg. This means the sandbox only ever dials one fixed internal endpoint — collectors on any port or scheme (e.g. `https://collector:4318`) work without special egress rules, and the backend endpoint and auth headers (`OTEL_EXPORTER_OTLP_HEADERS`) stay host-side and are **never** forwarded into the untrusted sandbox. The collector cannot be redirected by sandbox traffic, so it adds no SSRF/exfil surface.
- **`gondolin` / `none`:** `agentic-pi` runs in the harness process and already inherits the harness OTEL SDK. Allowlisted `OTEL_*` env vars are forwarded into the sandbox shell env directly; `gondolin` adds collector hosts (parsed from `OTEL_EXPORTER_OTLP_ENDPOINT`, signal-specific endpoint env vars, and `LASTLIGHT_OTEL_COLLECTOR_HOSTS`) to its egress allowlist. Private/internal metadata hosts remain blocked.

Set `LASTLIGHT_OTEL_FORWARD_TO_SANDBOX=false` to disable sandbox telemetry entirely and keep collector endpoints/headers in the harness only.

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

## Claude Code skills

Last Light ships a [Claude Code](https://docs.claude.com/en/docs/claude-code)
**plugin** that teaches Claude Code how to install, configure and operate Last
Light for you. Install the skills, then in a Claude Code session just ask — e.g.
*"set up a Last Light server"*, *"connect my CLI to my server"*, *"fork the build
workflow into my overlay"*, or *"scaffold a Last Light evals workspace"*.

| Skill | Use it when you want to… |
|-------|--------------------------|
| `lastlight-server` | Install & configure a Last Light server (agent + docker stack). |
| `lastlight-client` | Point the `lastlight` CLI at a server and log in. |
| `lastlight-overlay` | Create a deployment overlay and fork workflows/prompts/skills/persona. |
| `lastlight-evals` | Scaffold & run a Last Light Evals workspace (datasets, models, comparisons). |

Install them with the CLI (version-matched to the installed `lastlight`, works
offline — uses the `claude` plugin marketplace when present, else copies the
skills into `~/.claude/skills`):

```bash
lastlight skills install                 # → ~/.claude/skills (user scope)
lastlight skills install --scope project # → ./.claude/skills (this repo only)
lastlight skills list                    # show bundled skills + where they're installed
lastlight skills uninstall
```

Or register the marketplace directly — this repo root is itself a Claude Code
marketplace (from a checkout, or straight from GitHub):

```bash
claude plugin marketplace add ./                 # from a local checkout
claude plugin marketplace add nearform/lastlight # or straight from GitHub
claude plugin install lastlight@lastlight-skills
```

The plugin lives at the repo root — `plugins/lastlight/` (manifest in
`.claude-plugin/`). The published `lastlight` CLI stages a copy into its own
package at build (`packages/cli/scripts/copy-plugin.mjs`) so `lastlight skills
install` works offline after a global install. These are *Claude Code* skills —
distinct from Last Light's internal sandbox skills in `apps/server/skills/`.

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
   - `comment.created` with `@last-light` from a maintainer → routed by intent classifier (build / explore / question / triage / review / security / verify / qa-test / demo)
3. **Workflow runner** loads the matching YAML, dispatches each phase to `executeAgent` (`src/engine/agent-executor.ts`, which invokes agentic-pi) or, for chat, `ChatRunner` (`src/engine/chat-runner.ts`, in-process pi-ai)
4. **Build workflow** runs a multi-phase cycle:
   - Phase 1: **Architect** — read-only analysis, writes plan to `.lastlight/issue-N/architect-plan.md`
   - Phase 2: **Executor** — TDD implementation following the plan
   - Phase 3: **Reviewer** — independent verification (no shared context with executor)
   - Phase 4: **Fix loop** (up to 2 cycles if reviewer requests changes)
   - Phase 5: **Create PR**

### Cron

When webhooks are enabled, only the weekly reports (health + security) run on cron (issue/PR events arrive in real-time via webhooks). Without webhooks, triage and PR review also run on cron.

| Job | Schedule | Condition |
|-----|----------|-----------|
| Triage new issues | Every 15 min | Only without webhooks |
| Check PRs for review | Every 30 min | Only without webhooks |
| Weekly health report | Mondays 9am | Always |
| Weekly security scan | Mondays 10am | Always |

---

## Project Structure

This is a pnpm + Turborepo workspace. Everything below is the effective layout;
the full annotated map lives in the root [`CLAUDE.md`](CLAUDE.md).

```
lastlight/                      # private root package (lastlight-monorepo)
  CLAUDE.md                     # canonical workspace map + dev orientation
  .claude-plugin/               # Claude Code marketplace manifest (repo = a marketplace)
  plugins/lastlight/            # the Claude Code plugin (skills) — staged into packages/cli at build
  apps/
    server/                     # @lastlight/core — the harness + server
      src/                      #   index.ts (entry), engine/, connectors/,
                                #   workflows/, sandbox/, cron/, admin/, state/ …
      config/                   #   config loader + config/default.yaml
      workflows/                #   YAML workflow definitions + prompts/
      skills/                   #   internal sandbox skills (pr-review, building, …)
      agent-context/            #   soul.md / rules.md / security.md (bot persona)
      dashboard/                #   React + Vite admin SPA
      spec/                     #   rebuild-grade architecture spec
      deploy/                   #   entrypoint.sh, native/ systemd deploy, Caddyfile
      Dockerfile                #   harness image
      sandbox*.Dockerfile       #   sandbox images for LASTLIGHT_SANDBOX=docker
      docker-compose.yml        #   compose stack + docker-bake.hcl
      CLAUDE.md                 #   server-package development guide
    www/                        # lastlight-www — Astro site → lastlight.dev
    evals/                      # lastlight-evals — eval harness → evals.lastlight.dev
  packages/
    cli/                        # lastlight — the lean published global CLI
      src/                      #   cli.ts (entry), cli-server.ts, oauth-cli.ts, …
      scripts/copy-plugin.mjs   #   stages the root plugins/ + .claude-plugin/ into
                                #   this package at build (so the npm tarball ships them)
    shared/                     # @lastlight/shared — e.g. src/providers.ts (registry)
    workflow-engine/            # @lastlight/workflow-engine — reusable phase runner
```

Core internals that used to sit at the repo root (`src/`, `workflows/`,
`skills/`, `agent-context/`, `deploy/`, `config/`, `Dockerfile`, `docker-compose.yml`,
`Caddyfile`, `spec/`) now live under `apps/server/`.

## Troubleshooting

### Installing the CLI

`npm i -g lastlight` installs the **lean** `lastlight` package (`packages/cli/`).
It's a thin client + host-local `server` lifecycle and carries none of the
server's native or AI dependencies (no `better-sqlite3`, no `@google/genai`), so
the install is fast and free of the transitive-deprecation noise those deps used
to print. The heavy runtime lives in `@lastlight/core` (`apps/server/`) and is
installed on the host separately (the docker stack or `lastlight server` build).

### Server won't start

```bash
# Check .env is loaded
pnpm --filter @lastlight/core dev:server
# Look for "Required environment variable not set" errors
```

### `pnpm --filter @lastlight/core dev` says the sandbox image is missing (docker-sandbox mode)

```bash
docker compose --profile build-only build sandbox-base   # shared base first
docker compose --profile build-only build sandbox
```

### Workflow run fails with `exit 127: sh: 1: agentic-pi: not found`

The sandbox image needs `agentic-pi` baked in. Rebuild it:

```bash
docker compose --profile build-only build sandbox-base   # shared base first
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

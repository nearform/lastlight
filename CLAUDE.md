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
API credentials are read from the provider env vars in the registry at
`src/providers.ts` — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`,
`GROQ_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, `HF_TOKEN`,
`MOONSHOT_API_KEY`, `NVIDIA_API_KEY`, `FIREWORKS_API_KEY`,
`TOGETHER_API_KEY`, `DEEPSEEK_API_KEY`, `ZAI_API_KEY`,
`KIMI_API_KEY`, `MINIMAX_API_KEY`. Set whichever provider(s)
match your `OPENCODE_MODEL` / `OPENCODE_MODELS`. No `claude` CLI, no
Anthropic SDK in the runtime path.

**Subscription logins (OAuth).** Besides the API-key providers above, three
providers authenticate by subscription login instead of a static key —
`openai-codex` (ChatGPT Plus/Pro), `anthropic` (Claude Pro/Max), and
`github-copilot`. They're registered in `OAUTH_PROVIDERS` in `src/providers.ts`
(separate from the API-key `PROVIDERS`). `src/engine/oauth.ts` is the shared
layer: one on-disk store (`$STATE_DIR/auth.json`, override `LASTLIGHT_AUTH_FILE`
— same JSON shape pi-ai's own CLI writes), `resolveOAuthApiKey()`
(refresh-if-expired + persist), and the model-prefix→provider-id map.
`lastlight oauth login|list|status|test|logout` (host-local,
`src/cli/oauth-cli.ts`) drives the browser flow. **Two seams, different reach:**
the in-process **chat** path (`chat-runner.ts`) passes the token as a per-call
`apiKey`, so all three work; the **sandbox** path (`agent-executor.ts`) resolves
creds from env only and injects `ANTHROPIC_OAUTH_TOKEN` / `COPILOT_GITHUB_TOKEN`
— Codex has no env-token route, so it's **chat-only** (the executor warns if a
Codex model is used for a sandbox phase).

The cheap-helper path (`src/engine/llm.ts`, used by screener + classifier)
bypasses OpenCode and dispatches directly to the same three providers.
`defaultFastModel(taskType)` resolves the model in order: the config `models:`
map for the task key (`models.classifier` / `models.screener` in `config.yaml`,
which env `OPENCODE_MODELS` is layered into) → the env `OPENCODE_MODELS` map
directly → the first configured provider's fast model (Anthropic > OpenAI >
OpenRouter — direct routes avoid OpenRouter's per-token markup). Only an
explicit per-task entry counts, never `models.default`, so the helpers stay
cheap unless deliberately pinned.

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
  evals-api.ts          Public barrel for `lastlight/evals` — workflow driving
                        + overlay bootstrap symbols for external eval harnesses.
  managed-repos.ts      getManagedRepos / isManagedRepo helpers.
  session-log.ts        SessionLog + projectSlugForCwd.
  cli/                  CLI entry-point + host-local lifecycle commands.
    cli.ts              Thin client that POSTs to a running server.
    cli-config.ts       Auth + target resolution helpers.
    cli-server.ts       `lastlight server` lifecycle (docker compose wrappers).
    cli-format.ts       Table / age / color helpers for CLI output.
    cli-timeline.ts     Session timeline renderer.
    setup.ts            First-run setup wizard.
    fork-cli.ts         `lastlight fork` — copy built-in assets into overlay.
    skills-install.ts   `lastlight skills install` — install Claude Code skills.
  config/               Config loading + overlay helpers.
    config.ts           Layered config load: config/default.yaml +
                        optional $LASTLIGHT_OVERLAY_DIR/config.yaml + env
                        overrides. Secrets stay env-only. Exposes
                        getRuntimeConfig / getManagedRepos / getRoutes /
                        getPublicConfig.
    config-resolve.ts   Pure config layer resolution (default / overlay / env).
    overlay-assets.ts   Enumerate overlay vs core asset overrides/additions.
    overlay-bootstrap.ts Shared overlay repo scaffolding (detectGh,
                        scaffoldOverlayFiles, bootstrapOverlayRepo).
  connectors/           Platform abstraction — every event source emits an
                        EventEnvelope so the engine never sees raw payloads.
    github-webhook.ts   GitHub App webhook → EventEnvelope.
    slack/              Slack connector (HTTP Events API webhook, default;
                        Socket Mode dev fallback) + mrkdwn formatter.
    messaging/          Base class for all messaging platforms
                        (slack now, discord later). Owns SessionManager — the
                        per-thread conversation store.
  engine/
    router.ts           Deterministic, code-based routing of EventEnvelope
                        → { skill, context }. Classifies build intent via a
                        small LLM call. No LLM decides the tab.
    agent-executor.ts   Public executor surface: `executeAgent` /
                        `executeCommand`. Mints the scoped GitHub token,
                        assembles the sandbox env, then delegates to the
                        Sandbox orchestrator. Thin — no backend branching.
    executors/
      orchestrator.ts   The Sandbox orchestrator: `withSandbox` bracket +
                        `runSandboxedAgent` / `runSandboxedCommand`. Owns skill
                        staging, build-artifact stage/harvest, the
                        RunResultAccumulator + shim + recordPiEvent event loop,
                        session-id notify, and the single converged fallback.
                        Computes one intent-only `EgressPolicy` per run.
                        Written once for every backend (replaced the
                        executeDocker/executeSmol/executeInProcess twins).
      shared.ts         Backend-agnostic building blocks (RunResultAccumulator,
                        skill-bundle staging, server-artifact stage/harvest,
                        finalizeFromRunResult, env splice).
    dispatcher.ts       Routes classified events to workflow or chat handler.
    event-shim.ts       Translates agentic-pi events → Claude-SDK envelope jsonl.
    llm.ts              One-shot LLM helper for screen/ + classifier —
                        direct fetch to Anthropic Messages or OpenAI Chat
                        Completions based on the model id prefix.
    github/             GitHub auth + client layer.
      git-auth.ts       GitHub App JWT → installation token. Supports
                        permission downscoping and a per-token repo allowlist.
      github.ts         Harness-side Octokit client (post comments, create
                        issues, react to comments). Not used by agents.
      github-tools.ts   In-process GitHub tools for the chat path.
      github-app-client.ts  GitHub App Octokit factory (JWT + token auth).
      profiles.ts       ExecutorConfig / ExecutionResult / GitSandboxAccess
                        types + GITHUB_PERMISSION_PROFILES + loadAgentContext.
    chat/               In-process chat path (Slack thread → pi-ai).
      chat.ts           Chat skill — one pi-ai session per Slack thread.
      chat-runner.ts    pi-ai conversation driver with retry logic.
      chat-skills.ts    Chat skill catalogue + read_skill tool.
      message-batcher.ts  Debounce bursty Slack message bursts before routing.
    screen/             Prompt screening + intent classification.
      screen.ts         Prompt-injection screener. Uses llm.ts with a cheap
                        model (claude-haiku by default).
      classifier.ts     Tiny LLM call that classifies a comment/message into
                        an intent (build / review / … / chat). Uses llm.ts.
                        The prompt is COMPOSED at runtime, not hardcoded: a
                        forkable base (workflows/prompts/classifier.md) + one
                        `classification:` block per workflow YAML. Adding a
                        workflow (even in an overlay) adds a routable intent
                        with no core edit — the router's getWorkflowByIntent
                        fallback routes it. `lastlight fork classifier` forks
                        the base prompt. (issue #164)
  workflows/            See src/workflows/CLAUDE.md for the full runner
                        story. Loads YAML definitions, executes phases
                        (linear or DAG), manages resume, approval gates,
                        loop iterations.
  sandbox/              Isolation backends for agent runs. One container/VM/
                        worktree per task, hardened path checks (gitdir mounts
                        validated against sandbox root, taskId traversal
                        rejected).
    sandbox.ts          The **Sandbox port** + `sandboxFor` factory + the four
                        adapters: `DockerSandbox`, `SmolSandbox`,
                        `InProcessSandbox` (`mode: gondolin | none`),
                        `FakeSandbox` (test-only). Each owns its isolation
                        mechanism + egress translation behind one interface
                        (`provision` / `stageSkills` / `runAgent` / `runCommand`
                        / `dispose`). The orchestrator (engine/executors) drives
                        them. See CONTEXT.md → "Sandbox execution".
    docker.ts           Docker container driver (`docker run` / `exec`) the
                        DockerSandbox adapter wraps.
    smol.ts             smolvm micro-VM driver the SmolSandbox adapter wraps.
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
                        `skill: a`); the runner stages each into a
                        per-phase bundle at `<workspaceRoot>/
                        .lastlight-skills/<phase>/<name>/` (symlink for
                        none, copy for docker/gondolin — gondolin mounts
                        only cwd so a symlink would dangle in the guest)
                        before the agent
                        runs, then maps it to the agent via pi's
                        `--skill`/`skillPaths`. The bundle sits at the
                        workspace root — a sibling of any checked-out
                        repo, never in its git tree — and is keyed per
                        phase so parallel phases stay isolated. The
                        agent keeps cwd = the repo (no `cd` preamble);
                        docker bind-mounts the whole workspace so the
                        sibling bundle is reachable by an absolute
                        `--skill` path. (gondolin mounts only cwd, so
                        there the bundle is staged under the repo +
                        local `.git/info/exclude` — never committed.) pi
                        surfaces the mapped skills as an XML system-prompt
                        catalogue and the agent reads each SKILL.md on
                        demand via its `read` tool. Chat threads use the same skills
                        in-process via a `read_skill` tool —
                        catalogue built at boot from CHAT_SKILL_NAMES
                        in src/engine/chat/chat-skills.ts.
agent-context/          *.md files concatenated and prepended as AGENTS.md
                        for every agent session — the bot's "personality"
                        plus hard rules. Sandbox entrypoint cats these into
                        $WORKSPACE/AGENTS.md; the chat-server supervisor
                        writes the same content + a chat-persona suffix
                        into its own AGENTS.md.

plugins/                Claude Code plugin (distinct from the internal
                        skills/ above). plugins/lastlight/ bundles
                        SKILL.md skills that teach Claude Code to install
                        and operate Last Light + Last Light Evals
                        (lastlight-server / -client / -overlay / -evals).
                        The repo root is also a Claude Code marketplace
                        (.claude-plugin/marketplace.json). Installed via
                        `lastlight skills install` (src/cli/skills-install.ts):
                        prefers `claude plugin marketplace add` of the
                        bundled path, falls back to copying the skill dirs
                        into ~/.claude/skills. Shipped in the npm package
                        (files: .claude-plugin + plugins).

deploy/                 Docker entrypoints, Caddyfile, systemd helpers.
dashboard/              React+Vite admin SPA, served from /admin at runtime.
```

## Key concepts

- **EventEnvelope** (`src/connectors/types.ts`) — canonical event shape.
  Every connector normalizes to it; the engine only ever sees EventEnvelopes.
- **Workflow** — a YAML file listing phases. The runner knows nothing about
  "build" vs "triage" — it just executes phases in order (or as a DAG). See
  `src/workflows/CLAUDE.md`.
- **Configuration & deployment overlay** (`src/config/config.ts`, `config/default.yaml`,
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
  via `getManagedRepos()` (runtime config, not a baked constant). **Effective
  managed-repo list:** a non-empty configured `managedRepos` wins and restricts
  to exactly those repos; when it's **empty**, the list is instead sourced from
  the **GitHub App installation** — the repos the App can access, fetched once at
  boot (`GitHubClient.listInstallationRepos()`, wired in `src/index.ts`) into an
  in-memory cache and kept live by `installation` / `installation_repositories`
  webhooks (`src/connectors/github-webhook.ts`). So an org install that already
  limits the App to a subset of repos need not maintain a second copy in config.
  The admin `/managed-repos` endpoint (Config → Managed repos pane) surfaces the
  configured / installation / effective lists + source. Caveat: for a
  `repository_selection: "all"` install, a newly-created org repo isn't picked up
  until the next boot fetch (no webhook fires); the `selected` case is fully
  covered. In the
  docker-compose stack the deployment folder is **`instance/`** (mounted
  read-only at `/app/instance`), holding `config.yaml` + asset overrides + a
  gitignored `secrets/` subdir (`.env`, `*.pem`). It's never baked into the
  image (no rebuild needed). Applying an edit: `config.yaml` and
  adding/changing an `.env` value take effect on `docker compose restart agent`
  (the entrypoint re-sources `.env`). **Removing** an `.env` value needs a
  recreate — `docker compose up -d agent` / `lastlight server start agent` —
  because compose injects `env_file` vars at container *creation* and a restart
  can't unset them. The dashboard `/config` endpoint surfaces Default / Overlay
  / Merged (non-secret). The overlay can also **pin the core version** via a
  `deploy.version` key (a git tag/ref, e.g. `v0.10.6`) — this is deployment
  config, not runtime behaviour: `lastlight server update|setup` checks core out
  at that tag instead of tracking `main`. Read host-side and in-container by
  `readCorePin()` (`src/config/core-pin.ts`); see "Redeploy a code change".
- **Two execution modes**:
  - **Sandbox** — workflow phases run inside a Docker sandbox
    (`src/sandbox`) with a minted per-run GitHub token. Each phase invokes
    `opencode run --format json` in the container and the harness parses
    the streamed events into an ExecutionResult + envelope jsonl. Every
    phase writes an `executions` row.
  - **Chat** — the chat skill (`src/engine/chat/chat.ts`) talks to the
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
- **Permission profiles** (`src/engine/github/profiles.ts`) — each workflow maps to
  a `GitAccessProfile`: `read`, `issues-write`, `review-write`, `repo-write`.
  `runner.ts` picks one per workflow name and the agent-executor mints a
  downscoped installation token for the sandbox. Only `repo-write` runs see
  the App PEM; everything else uses a pre-minted scoped token, which
  agentic-pi's built-in github tools (its `github` extension — the
  `github_*` tools, gated per profile) read from the sandbox env. The
  standalone `mcp-github-app` MCP server that used to expose these tools was
  removed with the OpenCode→agentic-pi migration.
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
  build-assets/             Server-mode build handoff docs (only when
                            buildAssets.location=server):
                            <owner>/<repo>/<issueKey>/*.md — never committed
                            into the target repo. Store: src/state/build-assets.ts.
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
npx vitest run           # full server suite (docker integration tests skip unless opted in)
cd dashboard && npx tsc -b  # dashboard typecheck

# Sandbox integration tests — actually start a docker sandbox and run a no-AI
# workflow (type: bash / type: script phases). Opt-in + self-gating: needs
# docker + the lean image built, else skips instantly.
docker compose --profile build-only build sandbox-base   # shared base first
docker compose --profile build-only build sandbox        # then the lean image
RUN_SANDBOX_IT=1 npx vitest run tests/sandbox/command-exec.integration.test.ts

# CLI — `lastlight` (bin → dist/cli.js; `npm run cli -- <args>` in dev)
# A thin client for a running instance: it POSTs triggers and reads the
# instance's admin API over HTTP. Target + token resolve from --url/--token →
# LASTLIGHT_URL/LASTLIGHT_TOKEN env → ~/.lastlight/config.json (written by
# `login`) → http://localhost:8644.
lastlight login [url]                  # browser-handoff auth, save token (~/.lastlight)
lastlight login <url> --password       # headless fallback (POST /admin/api/login)
lastlight logout                       # clear ~/.lastlight/config.json
lastlight status                       # instance URL, server health, token validity
lastlight chat [message]               # chat with the bot (REPL if no message; POST /api/chat)
# Triggers (POST /api/run, /api/build):
lastlight <github-url>                 # default: triage the issue (cheap)
lastlight owner/repo#N                 # shorthand
lastlight build owner/repo#N           # explicit full build cycle
lastlight triage|review owner/repo[#N] # repo-wide scan or single issue/PR
lastlight health|security owner/repo   # repo-level report
# Debug (read the admin API instead of SSH; all accept --json):
lastlight workflow list [--status s] [--workflow name] [--limit n]
lastlight workflow log <id> [--follow]
lastlight workflow retry <id>          # re-run a failed run from the phase that failed
lastlight session list|log <id> [--follow]
lastlight logs search "<text>" [--scope errors|messages|all]
lastlight server list                  # the lastlight-* docker containers
lastlight server logs [svc|container] [--tail n] [--since 10m] [--follow]
lastlight approvals list|approve <id>|reject <id> [--reason "..."]
lastlight stats [--daily n | --hourly n]
lastlight setup                        # first-run wizard (asks: client | server)

# Server lifecycle (HOST-LOCAL — run on the server, not over HTTP). Operate on a
# working directory (full repo checkout + instance/ overlay + override symlink)
# resolved from --home → LASTLIGHT_HOME → ~/.lastlight serverHome → ~/lastlight.
lastlight server setup                 # scaffold/adopt the working dir (clone core; clone OR
                                        # create the instance/ overlay — fresh overlay offers a
                                        # private `gh repo create` via src/config/overlay-bootstrap.ts)
lastlight server build                 # build the docker images FROM SOURCE (agent + sandbox-base
                                        # + sandbox + sandbox-qa) without starting anything — the
                                        # local-build escape hatch (server update pulls prebuilt)
lastlight server start|stop|restart [service]   # docker compose up -d / stop|down / restart
                                        # (start pre-checks the lastlight-agent image exists; if
                                        # not it points at `server update`)
lastlight server update                # the canonical deploy: pull core+overlay, then PULL the
                                        # prebuilt images from GHCR (ghcr.io/nearform/lastlight-*)
                                        # tagged by deploy.version (else :latest) + re-tag to the
                                        # local names, up -d --remove-orphans, restart sidecars,
                                        # health-check. --local builds from source instead (the
                                        # old behaviour). [--no-core --no-overlay --no-build
                                        # --local --yes]
lastlight server status                # compose ps + core/overlay version drift +
                                        # forked-asset overrides (shadows default / added)

# Fork built-in assets into the instance/ overlay (HOST-LOCAL; src/cli/fork-cli.ts).
# Copies the chosen built-ins into instance/ so they shadow the defaults by
# logical name (overlay wins at startup). Resolution: explicit --home wins;
# else cwd if it's an overlay/checkout; else the server home.
lastlight fork                         # list forkable workflows + agent-context (marks forked)
lastlight fork <workflow>              # workflow YAML + every prompt + skill its phases reference
lastlight fork agent-context [file]    # all agent-context/*.md (soul/rules/security), or one file
lastlight fork classifier              # the base intent-classifier prompts (classifier.md +
                                        # classify-adds-info.md); per-workflow category text
                                        # travels with `fork <workflow>` already
                                        # [--home dir] [--force to overwrite existing]

# Install the Last Light Claude Code skills into a local Claude Code (HOST-LOCAL;
# src/cli/skills-install.ts). Prefers `claude plugin marketplace add` of the bundled
# plugins/ path; falls back to copying skill dirs into the scope's .claude/skills.
lastlight skills install               # → ~/.claude/skills (user) [--scope project] [--no-marketplace]
lastlight skills list                  # bundled skills + where they're installed
lastlight skills uninstall             # remove them [--scope user|project]

# Subscription logins (HOST-LOCAL; src/cli/oauth-cli.ts). Browser OAuth flow +
# credential store at $STATE_DIR/auth.json (override LASTLIGHT_AUTH_FILE);
# restart the agent to apply. Codex is chat-only (no sandbox env-token route).
lastlight oauth login [provider]       # openai-codex | anthropic | github-copilot
lastlight oauth list                   # providers + login status
lastlight oauth status                 # store path + token expiry
lastlight oauth test <provider>        # force a refresh to verify the login
lastlight oauth logout [provider]      # remove one (or all) [--auth-file f] [--state-dir d]

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
- **Bot identity** (optional; defaults to `last-light`) — `botName` is the
  GitHub App slug (no `[bot]` suffix) and the single source of truth for the
  bot's identity. Set it in the overlay `config.yaml` (`botName:
  nearform-lastlight`) or via the `GITHUB_APP_BOT_NAME` env var. It derives
  three things: the incoming **`@mention` handle** the router triggers on
  (`@<botName>` — *only* the configured handle matches, no legacy fallback),
  the **`botLogin`** used to filter the bot's own comments/reviews
  (`<botName>[bot]`, still overridable with `BOT_LOGIN`), and the **git commit
  author** for agent commits (`<botName>[bot]`). Must match the real App slug
  so `@`-autocomplete and notifications work.
- One of the provider API-key env vars from `src/providers.ts`
  (Anthropic / OpenAI / OpenRouter / Google / Mistral / Groq / Cerebras /
  xAI / Hugging Face / Moonshot / NVIDIA / Fireworks / Together / DeepSeek /
  Z.AI / Kimi / MiniMax) matching your `OPENCODE_MODEL` (set multiple if
  `OPENCODE_MODELS` routes phases to different providers)

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
  subdir. Read at startup — restart to apply (but *removing* an `.env` var needs
  a recreate, `lastlight server start agent`; see the `instance/` note above).
- `STATE_DIR` — persistent state dir (default `./data`)
- `DB_PATH` — override SQLite path
- `LASTLIGHT_HOME` — working directory for the host-local `lastlight server`
  lifecycle commands (start/stop/restart/update/status): a full repo checkout +
  `instance/` overlay + `docker-compose.override.yml` symlink (the docker build
  context). Resolution: `--home` flag → this env → `serverHome` in
  `~/.lastlight/config.json` (written by `lastlight server setup`) → `~/lastlight`.
  CLI-side only — the harness itself doesn't read it.
- `LASTLIGHT_GIT_SHA` / `LASTLIGHT_BUILD_DATE` — core git SHA + build date baked
  into the agent image (Dockerfile `ARG`s). `lastlight server update` passes
  `--build-arg GIT_SHA=$(git rev-parse HEAD)`; surfaced by
  `GET /admin/api/server/info` for the dashboard drift banner. Empty → "unknown".
- `LASTLIGHT_CORE_VERSION` — override the overlay's `deploy.version` core-version
  pin (a git tag/ref) so CI can pin without editing `config.yaml`. Consumed by
  the host-local `lastlight server update|setup` and the in-container drift
  banner via `readCorePin()`. Unset (or `main`/`latest`) tracks `main`.
- `LASTLIGHT_BUILD_ASSETS` — `repo` (default) | `server`. In `server` mode the
  per-phase build handoff docs (`architect-plan.md`, `status.md`,
  `executor-summary.md`, `reviewer-verdict.md`, …) are externalized to the
  Last Light host instead of being committed into the target repo under
  `.lastlight/`. The executor stages the store's docs into the workspace
  before each phase and harvests them back afterwards
  (`src/engine/agent-executor.ts`); prompts gate their doc commit behind
  `{{#if !externalizeArtifacts}}`; `{{artifactUrl}}` links resolve to the
  dashboard's Artifacts view; the admin API serves them read-only at
  `/admin/api/artifacts`. Equivalent config: `buildAssets.location`.
- `BUILD_ASSETS_DIR` — server-mode build-asset store root
  (default `$STATE_DIR/build-assets`; layout
  `<owner>/<repo>/<issueKey>/*.md`, store in `src/state/build-assets.ts`)
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
- `LASTLIGHT_PKG_CACHE_VOLUME` — docker named volume mounted at `/cache` in
  every sandbox as the shared package-manager download cache (issue #107).
  Default `lastlight_pkg-cache` (declared in docker-compose.yml). The
  sandbox env points `npm_config_cache` → `/cache/npm`,
  `npm_config_store_dir` (pnpm) → `/cache/pnpm`, and `YARN_CACHE_FOLDER` →
  `/cache/yarn`; the agent picks the package manager from the repo's
  lockfile (see `skills/pr-review/SKILL.md`), so repeated installs reuse
  already-fetched tarballs regardless of which one a repo uses. This is the
  *download* cache only — per-workspace `node_modules` stays per-workspace
  (a shared store can't hardlink across separate container mounts). Disk is
  bounded instead by per-PR workspace reuse (`PER_TARGET_REUSE_WORKFLOWS`
  in `src/workflows/simple.ts`) plus #106's reaping.

Sandbox (smolvm `smol` backend — experimental, opt-in):

- `LASTLIGHT_SANDBOX=smol` runs each phase in a smolvm micro-VM (own kernel
  via Hypervisor.framework / KVM). Local-only: needs the `smolvm` CLI on PATH
  and a host hypervisor. Driven by `SmolSandbox` (`src/sandbox/smol.ts`) over
  the smolvm CLI — peer of the docker backend (runs `agentic-pi run --sandbox
  none` inside the VM). Not the default; `config/default.yaml` stays `gondolin`.
- `SMOLVM_BIN` — `smolvm` CLI path (default `smolvm`).
- `SMOLVM_IMAGE` — OCI ref OR a local `docker save` archive / rootfs dir
  (default `lastlight-sandbox:latest`). The archive form loads offline (no
  registry) so it works under the strict allowlist: `docker save
  lastlight-sandbox:latest -o img.tar` then `SMOLVM_IMAGE=img.tar`.
- Egress is native per-machine `--allow-host` from the same
  `egress-allowlist.ts` — no coredns/nginx sidecars. **Caveat:** smolvm
  resolves each host at VM start and the filter is IP-pinned (not
  apex+subdomain like docker SNI / gondolin); unresolvable apex-only entries
  are pre-dropped. Workspace bind-mounts at `/workspace` (smolvm's special
  path → direct share). See `spec/09-sandbox.md`. Opt-in IT:
  `RUN_SMOL_IT=1 SMOLVM_IMAGE=<archive> npx vitest run tests/sandbox/smol.integration.test.ts`.

Sandbox workspace provisioning (issue #107):

- **Shallow clone** — read-only workflows (everything except the
  `repo-write` profiles `build` / `pr-fix` / `security-feedback`) pre-clone
  at `--depth 1 --single-branch`; code-pushing workflows keep `--depth 50`.
  See `gitSandboxAccessForWorkflow` (`src/workflows/runner.ts`) →
  `prePopulateWorkspace` (`src/sandbox/index.ts`).
- **Per-PR workspace reuse** — `pr-review` / `pr-fix` workspaces are keyed
  by (repo, PR) and reused across runs. A `<workDir>/.lastlight-run` marker
  records the owning run: same run → preserve the checkout for the next
  phase; a different run reusing the dir → `git fetch` + `reset --hard` +
  `git clean -fdx -e node_modules` (deps stay warm). See the workflows
  guide's "taskId scoping" section.
- **Per-issue build recreate (issue #153)** — `build` workspaces are keyed by
  (repo, issue) too, but a different-run marker → **delete the leftover
  checkout and re-clone from the default branch** (`recreateFromBase`), so a
  re-triggered incomplete build starts again off current `main` and never
  inherits a stale feature branch. A same-run resume still preserves the
  checkout. Policy sets: `src/workflows/target-policy.ts`.

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

- `ADMIN_PASSWORD` — enables password login. Auth is required when a password
  **or** a working OAuth provider (Slack / GitHub) is configured; the dashboard
  is only fully open when *no* login method is set. Clearing the password while
  OAuth is configured keeps auth on (OAuth-only).
- `ADMIN_SECRET` — HMAC secret for session tokens

Slack (optional):

- `SLACK_BOT_TOKEN` (xoxb-…) — enables the messaging connector + chat skill.
- `SLACK_MODE` — `webhook` (default/prod, reliable HTTP Events API) or
  `socket` (dev fallback, Socket Mode). Auto-detected when unset: `webhook`
  if `SLACK_SIGNING_SECRET` is present, else `socket`. So shipping the code
  without the secret leaves an existing Socket-Mode instance on `socket`.
- `SLACK_SIGNING_SECRET` — Events API request-signing secret. Required for
  `webhook` mode. Slack POSTs events to `/webhooks/slack` on the shared HTTP
  server (the same Hono app as the GitHub webhook); webhook delivery is
  at-least-once (Slack retries), unlike Socket Mode which can drop messages.
- `SLACK_APP_TOKEN` (xapp-…) — app-level token; required only for `socket` mode.
- `SLACK_DELIVERY_CHANNEL` — channel id for cron reports
- `SLACK_ALLOWED_USERS` — comma-separated user ids allowlist
- `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`,
  `SLACK_OAUTH_REDIRECT_URI` — enables "Login with Slack" on the dashboard
  (OIDC via arctic, uses `openid.connect.userInfo`)
- `SLACK_ALLOWED_WORKSPACE` — restrict OAuth login to one team_id / domain
- `CHAT_BATCH_DEBOUNCE_MS` — settle window (ms, default 700; 0 disables) the
  `MessageBatcher` waits to coalesce a bursty thread before routing, so a rapid
  multi-message burst is classified once and answered as one ordered turn
  (`src/engine/chat/message-batcher.ts`, gated at `registry.onEvent`).

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

Deploys are driven by the **`lastlight` CLI**, installed globally on the host
and run as the `lastlight` user (with `LASTLIGHT_HOME=/home/lastlight/lastlight`,
which is also `~lastlight/lastlight`, so the default resolves):

```bash
ssh <production-server>
# ALWAYS update the global CLI FIRST — it's versioned separately from the agent
# image, and new deploy behaviour (e.g. the GHCR image-pull path) lives in the
# CLI. A stale CLI silently uses the old path (e.g. builds locally, ignores a
# pin). Match the version you're deploying:
npm i -g lastlight@<version>          # e.g. lastlight@0.12.0 (or @latest)
sudo -u lastlight -i lastlight server update
```

`lastlight server update` (`src/cli/cli-server.ts`) is the single source of truth. It:

1. `git pull` the `instance/` overlay **first** as the `lastlight` user (its
   read-only deploy key, `git@github-instance:cliftonc/lastlight-instance.git`;
   clones it if missing) and symlinks `instance/docker-compose.override.yml`
   into the project root — so a freshly-bumped core-version pin is visible
   before the core is converged.
2. Converge the core checkout (`/home/lastlight/lastlight`). If the overlay
   declares a **core-version pin** (`deploy.version` in `config.yaml`, or the
   `LASTLIGHT_CORE_VERSION` env override) it `git fetch origin --tags` +
   `git checkout <tag>` (detached HEAD); otherwise it `git checkout main` +
   `git pull --ff-only origin main`. The pin (`readCorePin`,
   `src/config/core-pin.ts`) is how the overlay repo drives *which core version*
   an instance runs: bump `deploy.version`, commit, and a CI/CD job (or a human)
   running `lastlight server update` converges the host to it. `server setup`
   applies the same pin before its first build. Unset (or the sentinels
   `main`/`latest`) = track `main`.
3. **Fetches the images.** By default it *pulls* the prebuilt images from GHCR
   rather than building them on the host — a release publishes
   `ghcr.io/nearform/lastlight-{agent,sandbox-base,sandbox,sandbox-qa}` via the
   `images` job of `.github/workflows/publish.yml` (on GitHub Release +
   `workflow_dispatch`, amd64, public). `server update` pulls the tag `resolveImageTag` returns — the
   overlay's `deploy.version` pin (e.g. `v0.11.0`) when set, else `:latest` — and
   re-tags each to its **local** name (`lastlight-agent`,
   `lastlight-sandbox:latest`, …), which is what `docker-compose.yml` and the
   harness (fixed names in `src/sandbox/images.ts`) reference. sandbox-qa is
   non-fatal; a missing required image errors with a pointer to `--local`. This
   moves the slow build OFF the deploy host — a pull is seconds. The stock
   sidecar images (coredns/nginx/otel-collector/caddy) are pulled from Docker
   Hub by compose and aren't published by us; `egress-init` reuses the agent
   image. **`--local`** reverts to building from source in dependency waves (both
   `sandbox` and `sandbox-qa` are `FROM` the shared `lastlight-sandbox-base`, and
   `docker compose build` builds one invocation's services in parallel, so the
   base must be built first): `docker compose build agent sandbox-base
   --build-arg GIT_SHA=<HEAD>`, then `docker compose build sandbox`, then a
   non-fatal `docker compose build sandbox-qa`. The CI publish workflow builds in
   the same order and passes `GIT_SHA=<release SHA>` so a pulled image's stamped
   version (`GET /admin/api/server/info` + the dashboard drift banner) is
   correct. The sandbox images install agentic-pi from the committed
   `sandbox/agentic-pi.pin` (not the whole lockfile), so an ordinary version bump
   doesn't rebuild them — and sandbox-qa's ~300 MB Chromium stays cached unless
   its own inputs change.
4. `docker compose up -d --remove-orphans` (recreates only what changed).
5. Force-restarts the egress sidecars (`coredns-strict`, `coredns-open`,
   `nginx-egress-strict`, `nginx-egress-open`, `otel-collector`) so they
   re-read any regenerated nginx/coredns/collector configs.
6. Health-checks `http://127.0.0.1:8644/health`, with live progress throughout.

The CLI is the control plane — npm-versioned and **separate from the agent
image it builds**, so it survives the agent container recreating itself.
`server start|stop|restart|status` cover the rest of the lifecycle, and
`server status` (plus the dashboard's drift banner, `GET /server/info`) reports
when core/overlay are behind. **When a core-version pin is set**, the drift
check repoints from `main` to the pinned tag: `server status` shows
`pinned vX.Y.Z`, and the dashboard banner stops nagging about `main`-drift —
it only warns "redeploy needed" when the running image's SHA is behind the
pinned tag (pin bumped but not yet deployed), else shows a quiet "Pinned to
vX.Y.Z" label.

So a normal deploy is: **commit + push to `main`, then run `lastlight server
update` on the host.** Code changes (anything under `src/`, `workflows/`,
`skills/`, `agent-context/`, `config/default.yaml`) reach prod through a
**published image**: cut a release (whose `publish.yml` `images` job builds them)
and bump the overlay's `deploy.version` to that tag, then `server update` pulls it. To
deploy un-released `main` (or local edits) build on the host with `server update
--local` (or `server build`). Deployment-only config (the `instance/` overlay)
can instead be
edited + committed to the `lastlight-instance` repo and applied with just
`lastlight server restart agent` — no image rebuild. (Caveat: *removing* an
`.env` var needs a recreate, `lastlight server start agent`, not a restart —
env_file vars are injected at container creation.)

> The host repo must be owned by the `lastlight` user (`chown -R
> lastlight:lastlight /home/lastlight/lastlight`) so the as-`lastlight` git pull
> can write `.git/objects`. There is no longer a root-run `deploy.sh` to drift
> that ownership back.

### Operate / debug

```bash
ssh <production-server>
sudo -u lastlight -i bash         # become the lastlight user
lastlight server status            # compose state + core/overlay drift
lastlight server logs agent --follow   # live harness logs
lastlight server restart agent     # after a config.yaml or .env add/edit
lastlight server start agent       # after REMOVING an .env var (recreate)
```

### Cutting a release (npm + GitHub)

**Release when the CLI *or* the `lastlight/evals` barrel surface changes.**
Pure prod-facing harness/dashboard/asset/doc changes reach prod via `lastlight
server update`, not npm — those alone don't need a release. But the standalone
`lastlight-evals` repo (`~/work/lastlight-evals`) consumes core as an npm
dependency through the `lastlight/evals` barrel (`src/evals-api.ts` — workflow
driving + overlay bootstrap symbols), so a harness change that alters how those
symbols run workflows (e.g. the workflow runner, `phase-executor.ts`, the
sandbox port, config resolution) must be published for evals to pick it up —
cut a release even though the CLI is untouched. When in doubt, if the change
affects the workflow-execution path that evals drives, release it. (See the
npm-release-policy note in local agent memory.) A release is a version bump + a
`vX.Y.Z` tag + a GitHub release. **Publishing is automated** — creating the
GitHub release fires the `publish.yml` workflow, which runs as two ordered jobs.
First `images` builds + pushes the four Docker images to
`ghcr.io/nearform/lastlight-*` tagged `vX.Y.Z` (via `docker buildx bake` +
`docker-bake.hcl`; moves `:latest` for non-prerelease releases). Then `npm`
(which `needs: images`) typechecks + tests + builds + publishes to npm using a
repo token (no 2FA). **The order is deliberate:** the CLI only goes live once the
`:vX.Y.Z` images it tells hosts to pull already exist in GHCR — otherwise a
`npm i -g lastlight@X.Y.Z && server update` in the gap would fail the image pull.
Do NOT run `npm publish` or prompt for an OTP; just watch the release run and
confirm the version went live. The image build is what lets a deploy host
`server update` *pull* the new version instead of building it — so after cutting
the release, bump the overlay's `deploy.version` to the tag to roll it out.
(`workflow_dispatch` on `publish.yml` rebuilds only the images for a given tag;
the `npm` job is gated to `release` events.)

Patch for fixes/doc tweaks to the CLI surface; minor for new user-facing
commands/features. The dance (run on a clean `main`, up to date with origin):

```bash
npm version patch --no-git-tag-version   # bump package.json + package-lock.json (minor for new features)
# keep the Claude Code plugin manifest version in lockstep:
#   edit plugins/lastlight/.claude-plugin/plugin.json "version" to match
npm run build                            # refresh dist/ (shipped via package `files`; not committed)
git add package.json package-lock.json plugins/lastlight/.claude-plugin/plugin.json
git commit -m "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"           # annotated — this repo's git config rejects lightweight tags
git push origin main --follow-tags       # pushes the release commit AND the tag
gh release create vX.Y.Z --title "vX.Y.Z — <summary>" --latest --notes "<changelog>"
#   notes convention: highlights + a compare link, vPREV...vX.Y.Z
#   → this triggers publish.yml, which publishes to npm automatically.

# Confirm the automated publish landed (plain `npm view` can serve a stale cache):
gh run watch <run-id> --exit-status
npm view lastlight@X.Y.Z version --prefer-online   # note: no `v` prefix on npm versions
```

Notes:
- The version lives in THREE files — `package.json`, `package-lock.json`
  (both handled by `npm version`), and `plugins/lastlight/.claude-plugin/plugin.json`
  (manual). Keep all three in sync.
- For an annotated tag, `git rev-parse vX.Y.Z` returns the tag object SHA, not
  the commit — use `git rev-parse 'vX.Y.Z^{commit}'` to confirm it points at the
  release commit.

## Sub-folder docs

- `src/workflows/CLAUDE.md` — runner internals: phase types, linear vs DAG,
  loop iteration naming (`reviewer_fix_1`, `reviewer_recheck_1`), approval gates,
  resume semantics, taskId scoping, template rendering.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues in `nearform/lastlight` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical triage vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

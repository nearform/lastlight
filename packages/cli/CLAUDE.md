# Last Light CLI — `lastlight`

The published **`lastlight`** binary (`packages/cli`, bin → `dist/cli.js`). Two
distinct roles live here:

1. **A thin client** for a running instance — POSTs triggers and reads the admin
   API over HTTP. Target + token resolve from `--url`/`--token` →
   `LASTLIGHT_URL`/`LASTLIGHT_TOKEN` env → `~/.lastlight/config.json` (written by
   `login`) → `http://localhost:8644`.
2. **Host-local server lifecycle** (`lastlight server …`) — runs *on the deploy
   host*, wrapping `docker compose`. Never goes over HTTP.

**Dependency invariant:** the CLI depends only on `lastlight-shared` +
`lastlight-workflow-engine` (`workspace:*`) — it **never** gains an edge to
`lastlight-core`. See the root `CLAUDE.md` dependency graph.

## Files (`packages/cli/src/`)

```
cli.ts            Thin client that POSTs to a running server (the default entry).
cli-config.ts     Auth + target resolution helpers.
cli-server.ts     `lastlight server` lifecycle (docker compose wrappers). Single
                  source of truth for `server update` (pull/build/prune).
cli-format.ts     Table / age / color helpers for CLI output.
cli-timeline.ts   Session timeline renderer.
setup.ts          First-run setup wizard (client | server).
fork-cli.ts       `lastlight fork` — copy built-in assets into the overlay.
oauth-cli.ts      `lastlight oauth login|list|status|test|logout` (subscription logins).
skills-install.ts `lastlight skills install` — install the Claude Code skills/plugin.
```

`packages/cli/tests/cli-server.test.ts` unit-tests the pure retention logic
(`tagsToPrune`) behind `server update`'s image prune.

## Client commands

```bash
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
lastlight workflow retry <id>          # re-run a failed OR cancelled run from where it stopped
lastlight session list|log <id> [--follow]
lastlight logs search "<text>" [--scope errors|messages|all]
lastlight server list                  # the lastlight-* docker containers
lastlight server logs [svc|container] [--tail n] [--since 10m] [--follow]
lastlight approvals list|approve <id>|reject <id> [--reason "..."]
lastlight cron list                    # scheduled jobs: schedule, next/last run, status
lastlight cron trigger <name>          # run a cron now (fire-and-forget; useful for testing)
lastlight cron enable|disable <name>   # toggle a cron on/off (idempotent)
lastlight stats [--daily n | --hourly n]
lastlight setup                        # first-run wizard (asks: client | server)
```

Per-command help: `lastlight <cmd> help` (e.g. `lastlight cron help`) — the
top-level `lastlight` / `--help` is a compact index; detail lives under each
command's help.

## Server lifecycle (HOST-LOCAL)

Run on the server, not over HTTP. These operate on a working directory (full repo
checkout + `instance/` overlay + `docker-compose.override.yml` symlink) resolved
from `--home` → `LASTLIGHT_HOME` → `~/.lastlight` `serverHome` → `~/lastlight`.

```bash
lastlight server setup                 # scaffold/adopt the working dir (clone core; clone OR
                                        # create the instance/ overlay — fresh overlay offers a
                                        # private `gh repo create`, via lastlight-shared's
                                        # overlay-bootstrap)
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
                                        # health-check, then prune superseded image versions
                                        # (keeps the newest two per repo). --local builds from
                                        # source instead. [--no-core --no-overlay --no-build
                                        # --no-prune --local --yes]
lastlight server status                # compose ps + core/overlay version drift +
                                        # forked-asset overrides (shadows default / added)
```

`server update` (`cli-server.ts`) is the single source of truth for a deploy:
pull the `instance/` overlay first (so a freshly-bumped `deploy.version` core pin
is visible), converge the core checkout to that pin (`readCorePin`, else `main`),
**pull** the prebuilt GHCR images (`--local` builds from source in dependency
waves: `sandbox-base` before `sandbox`/`sandbox-qa`), `up -d --remove-orphans`,
force-restart the egress sidecars, health-check `:8644/health`, then prune
superseded image versions (keeps the newest `KEEP_IMAGE_VERSIONS` = 2 per repo).
The CLI is the **control plane** — npm-versioned and separate from the agent image
it builds, so it survives the agent container recreating itself. For the full
release→deploy flow see [`docs/RELEASING.md`](../../docs/RELEASING.md) and
`apps/server/CLAUDE.md` → Deployment.

## Fork built-in assets (`fork-cli.ts`)

Copies the chosen built-ins into `instance/` so they shadow the defaults by logical
name (overlay wins at startup). Resolution: explicit `--home` wins; else cwd if it's
an overlay/checkout; else the server home.

```bash
lastlight fork                         # list forkable workflows + agent-context (marks forked)
lastlight fork <workflow>              # workflow YAML + every prompt + skill its phases reference
lastlight fork agent-context [file]    # all agent-context/*.md (soul/rules/security), or one file
lastlight fork classifier              # the base intent-classifier prompts (classifier.md +
                                        # classify-adds-info.md) [--home dir] [--force]
```

## Install the Claude Code skills (`skills-install.ts`)

Prefers `claude plugin marketplace add nearform/lastlight` (remote GitHub → skills
auto-update; `--local` uses the bundled `plugins/` path); falls back to copying
skill dirs into the scope's `.claude/skills`.

```bash
lastlight skills install               # → ~/.claude/skills (user) [--scope project] [--local] [--no-marketplace]
lastlight skills list                  # bundled skills + where they're installed
lastlight skills uninstall             # remove them [--scope user|project]
```

## Subscription logins (`oauth-cli.ts`)

Browser OAuth flow + credential store at `$STATE_DIR/auth.json` (override
`LASTLIGHT_AUTH_FILE`); restart the agent to apply. Codex is chat-only (no sandbox
env-token route).

```bash
lastlight oauth login [provider]       # openai-codex | anthropic | github-copilot
lastlight oauth list                   # providers + login status
lastlight oauth status                 # store path + token expiry
lastlight oauth test <provider>        # force a refresh to verify the login
lastlight oauth logout [provider]      # remove one (or all) [--auth-file f] [--state-dir d]
```

## Commands (dev)

```bash
pnpm --filter lastlight build          # tsc → dist/ (+ chmod cli.js)
pnpm --filter lastlight typecheck
pnpm --filter lastlight test           # vitest
pnpm --filter lastlight exec tsx src/cli.ts <args>   # run from source (the `cli` script)
```

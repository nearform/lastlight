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
pr-cli.ts         `lastlight pr retry` — the admin-API client for the PR retry surface.
repo-cli.ts       `lastlight repo` — a managed repo's own `.lastlight/` config layer
                  (fork prompts/skills into it, validate it offline, show the server's
                  effective view). Reuses fork-cli's copy + core-root helpers.
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
lastlight pr retry owner/repo#N [reason]  # un-stick a PR the bot escalated (re-arms BOTH
                                        # budgets + re-runs the stuck workflow; the hold
                                        # label / run lock / fork guard still win)
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

## Un-stick a PR (`pr-cli.ts`)

`lastlight pr retry <owner/repo#N> [reason]` — the third of the three surfaces
that re-arm a pull request Last Light escalated (the other two are a
`@<bot> retry` comment and removing `requires-human`; see
[`docs/plans/stuck-pr-recovery/03-retry-intervention.md`](../../docs/plans/stuck-pr-recovery/03-retry-intervention.md)
and `apps/server/spec/05-router.md` → "Un-sticking an escalated PR"). One POST to
`POST /admin/api/prs/:owner/:repo/:number/retry`; everything after the reference
is the free-text reason, recorded on the retry and replayed to the next attempt
as a note (sanitized server-side — it can never forge a marker token).

The command is deliberately thin, because **every guard is the server's**: the
managed-repo allowlist, the hold label, the run lock, the fork guard and the fix
budgets are all decided at the same `applyPrDispatchGate` a webhook crosses. So
there are exactly three answers:

| server | meaning | CLI |
|---|---|---|
| 200 `dispatched: true` | re-armed and running now | ✓, naming the workflow, exit 0 |
| 200 `dispatched: false` | recorded — the gate skipped for an unrelated reason (a red base branch), so the next event honours it | ✓, naming the reason, exit 0 |
| 409 | refused, nothing recorded — the hold label, a run already working the PR, or a PR we could not read | the reason on stderr, **exit 1** |

That third row is why `pr retry` uses `apiPostStatus` rather than `apiPost`: a
refusal is an *answer*, not a transport failure, and `apiPost` dies on any
non-2xx. `parsePrRef` is narrower than `cli.ts`'s general `parseGitHubRef` on
purpose — a retry moves a PR's fix budgets, so an `/issues/N` URL is rejected
locally rather than 404'd remotely.

## Server lifecycle (HOST-LOCAL)

Run on the server, not over HTTP. These operate on a working directory (full repo
checkout + `instance/` overlay + `docker-compose.override.yml` symlink) resolved
from `--home` → `LASTLIGHT_HOME` → `~/.lastlight` `serverHome` → `~/lastlight`.

```bash
lastlight server setup                 # scaffold/adopt the working dir (clone core; clone OR
                                        # create the instance/ overlay — fresh overlay offers a
                                        # private `gh repo create`, via lastlight-shared's
                                        # overlay-bootstrap). Prompts, in order: GitHub tier →
                                        # App/PAT → domain → managed repos → STATE DATABASE
                                        # (SQLite default | external Postgres) → model+key →
                                        # admin password → Slack
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
lastlight server db check              # can the agent reach its state database? [--url <url>]
lastlight server db migrate            # copy the SQLite state into Postgres — one way, verified
                                        # [--to <postgres url>; default: the container's own
                                        #  DATABASE_URL, so no credential on the command line]
                                        # [--from <path> --driver pg|neon --batch n
                                        #  --dry-run --truncate --yes]
```

`server db` is the only pair here that does **not** run on the host: both shell
out to `docker compose run --rm --no-deps --entrypoint node agent
/app/dist/state/state-cli.js …`, so the work happens inside the agent image.
That is forced rather than chosen — `pg`, `@libsql/client` and the two Drizzle
schemas live in `lastlight-core`, and the CLI may never gain an edge to it — but
it is also the right answer: the probe then runs from the network the harness
will actually run on. `--no-deps` matters (compose would otherwise start the
egress sidecars as a side effect of a data migration), and so does
`--entrypoint node` (the image's normal entrypoint boots the harness, which
would open the database the command is about to copy). `migrate` refuses to run
while the agent is up, because a concurrent writer produces a target that is
quietly short of rows. Contract + the value-mapping details:
`apps/server/spec/10-state.md` → "Moving an existing database to Postgres".

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

## Per-repo config layer (`repo-cli.ts`, issue #180)

A **managed repo** may commit a `.lastlight/` directory that overrides a bounded
subset of config for runs against itself — same on-disk shape as an instance
overlay (`lastlight.yml`, `workflows/prompts/*.md`, `skills/<name>/SKILL.md`,
`agent-context/*.md`). These commands are that layer's authoring side and run
**inside your own code repo**, writing `<git repo root>/.lastlight/`.

```bash
lastlight repo fork                    # list what a repo may override
lastlight repo fork all                # every workflow's prompts + skills + agent-context + classifier
lastlight repo fork <workflow>         # a workflow's PROMPTS + SKILLS — never its YAML
lastlight repo fork agent-context [f]  # agent-context/*.md (ADDITIVE only — rename before committing)
lastlight repo fork classifier         # the base intent-classifier prompts [--home dir] [--force]
lastlight repo config validate         # check ./.lastlight/ offline; non-zero exit if anything is rejected [--json]
lastlight repo config show <owner/repo>  # the server's effective post-bounds config + provenance
                                        # (GET /admin/api/repos/:owner/:repo/config) [--refresh] [--json]
```

Three rules the commands enforce and explain in their output:

- **No workflow YAML.** A repo may retune a workflow's prompts and skills, never
  its definition (phases, permission profiles, approval gates) — `repo fork
  <workflow>` copies the prompts + skills only. Use `lastlight fork <workflow>`
  to change the definition in the *deployment overlay*.
- **agent-context is additive.** A repo file whose basename matches a built-in
  (`soul.md`, `rules.md`, …) is ignored at runtime, so `repo fork agent-context`
  warns to rename what it just copied.
- **No guessed destination.** Unlike `fork`, this never falls back to the server
  home's `instance/` — it refuses outside a git repo. (`--home` still points at
  a core checkout to read the *built-ins* from.)

`validate` runs the SAME pure validators the server runs
(`lastlight-shared/repo-config-schema` — the schema, operator bounds and merger
were factored out of `lastlight-core`'s `src/config/repo-config.ts` precisely so
the CLI can validate offline without an edge to core). It checks against the
*shipped default* bounds — `DEFAULT_REPO_CONFIG_ALLOW_KEYS` = `models`,
`variants`, `crons`, `disabled.workflows`, `disabled.crons`, `approval`, `fix`,
`dependencies`, `review` — since it can't know a deployment's narrowing; `repo
config show` is the authoritative
per-server answer. It errors if there's no `.lastlight/` directory at all, and
prints three blocks: the accepted files grouped by role (config / prompt / skill
/ agent-context), the **effective config overrides** it would apply, and every
rejection with its warning code. A `crons:` block is deliberately absent from the
overrides block — it's read off the raw layer by the scheduler at tick time, not
merged into the per-run config — and the "no config overrides" line says so.

Offline validation of the three **policy blocks** (`fix` / `dependencies` /
`review`, issues #251/#252) is deliberately the *widest* answer, not a guess:
merging against an empty base clamps them against the shipped values, which is
the loosest any deployment can be. So a value `validate` accepts may still be
clamped by a stricter operator — `repo config show` is where you find out. The
new warning code is **`policy-downgrade`** (`WARNING_LABEL` → "policy
downgrade"): the repo tried to be *less* conservative than the operator, so the
leaf was dropped and the operator's value stands. `repo config show` grew the
matching **Fix policy** / **Dependencies policy** / **Review policy** sections,
each with the same per-leaf provenance as Models / Approval gates.

`--dir <repo>` overrides the git-root discovery for `repo fork` / `repo config
validate` (mostly for tests); it still refuses a directory with no `.git`.

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

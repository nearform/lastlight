# lastlight

The command-line interface for [**Last Light**](https://lastlight.dev) — an AI
agent that triages, reviews, and fixes your GitHub repos.

`lastlight` is a **lean global CLI**. It does three things:

1. **A thin client** to a running Last Light server — it POSTs triggers and
   reads the instance's admin API over HTTP. It does not run the agent itself.
2. **Host-local `server` lifecycle** commands — scaffold, build, start, update,
   and inspect the Docker Compose stack on the machine that hosts an instance.
3. **The Claude Code plugin installer** — install the bundled Last Light skills
   into a local Claude Code (`lastlight skills install`).

The heavy runtime (the harness, workflow engine, sandbox stack) lives in the
`@lastlight/core` package; this CLI stays lean and has no native dependencies,
so `npm i -g lastlight` is fast.

## Install

```bash
npm i -g lastlight
```

## Connect to an instance

The target instance URL + token resolve from `--url` / `--token` flags →
`LASTLIGHT_URL` / `LASTLIGHT_TOKEN` env → `~/.lastlight/config.json` (written by
`login`) → `http://localhost:8644`.

```bash
lastlight login [url]                  # browser hand-off auth, saves the token to ~/.lastlight
lastlight login <url> --password       # headless fallback (POST /admin/api/login)
lastlight logout                       # forget the saved instance + token
lastlight status                       # instance URL, server health, token validity
lastlight setup                        # first-run wizard (client login or server stack)
```

## Trigger work

Point the bot at an issue, PR, or repo. These POST `/api/run` / `/api/build` on
the connected instance.

```bash
lastlight <github-url>                 # default: triage the issue (cheap)
lastlight owner/repo#N                 # shorthand for the same
lastlight build owner/repo#N           # the FULL build cycle (architect → executor → reviewer → PR)
lastlight triage owner/repo[#N]        # repo-wide scan, or a single issue
lastlight review owner/repo[#N]        # repo-wide PR scan, or a single PR
lastlight health owner/repo            # repo health report
lastlight security owner/repo          # security review
lastlight chat [message]               # chat with the bot (REPL if no message)
```

## Inspect & debug (read the admin API, no SSH)

```bash
lastlight workflow list [--status s] [--workflow name] [--limit n]
lastlight workflow log <id> [--follow]
lastlight workflow retry <id>          # re-run a failed run from the phase that failed
lastlight session list | log <id> [--follow]
lastlight logs search "<text>" [--scope errors|messages|all]
lastlight approvals list | approve <id> | reject <id> [--reason "..."]
lastlight stats [--daily n | --hourly n]
```

Most commands accept `--json` for scripting.

## Server lifecycle (host-local)

Run these **on the host** that runs the instance. They operate on a working
directory (a full checkout + `instance/` overlay) resolved from `--home` →
`LASTLIGHT_HOME` → `~/.lastlight` `serverHome` → `~/lastlight`.

```bash
lastlight server setup                 # scaffold/adopt the working dir; create or clone the overlay
lastlight server build                 # build the docker images from source
lastlight server start | stop | restart [service]
lastlight server update                # pull core + overlay, fetch prebuilt images, recreate, restart sidecars
lastlight server status                # compose state + core/overlay version drift
lastlight server list                  # the lastlight-* containers
lastlight server logs [service] [--tail n] [--since 10m] [--follow]
```

## Subscription logins (OAuth)

Log in to ChatGPT/Codex, Claude Pro/Max, or GitHub Copilot instead of using a
static API key. Host-local; restart the agent to apply.

```bash
lastlight oauth login [provider]       # openai-codex | anthropic | github-copilot
lastlight oauth list                   # providers + login status
lastlight oauth status                 # store path + token expiry
lastlight oauth test <provider>        # force a refresh to verify the login
lastlight oauth logout [provider]      # remove one (or all)
```

## Fork built-in assets & install skills

```bash
lastlight fork [workflow|agent-context [file]|classifier]   # copy built-ins into the instance/ overlay
lastlight skills install [--scope project] [--no-marketplace]   # install the Claude Code skills
lastlight skills list | uninstall
```

## Links

- Website & docs: <https://lastlight.dev>
- Monorepo: <https://github.com/nearform/lastlight> (this package is at
  `packages/cli/`; the harness is `@lastlight/core` at `apps/server/`)

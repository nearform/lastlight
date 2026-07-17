---
name: lastlight-client
description: Install the `lastlight` CLI and connect it as a CLIENT to an existing Last Light server — log in, save the token, and verify the connection. Use when the user wants to "connect / point my lastlight CLI at a server", "log in to Last Light", "set up the lastlight client", or run lastlight commands against a remote instance. For standing up the server itself use lastlight-server; for editing a deployment's config use lastlight-overlay.
version: 1.0.0
tags: [lastlight, client, cli, login, auth]
---

# Install & configure the Last Light CLI client

The `lastlight` CLI is a thin HTTP client: it POSTs triggers and reads a running
instance's admin API. As a *client* it needs only the instance URL and an auth
token, saved to `~/.lastlight/config.json` (mode 0600).

## 1. Install the CLI

```bash
command -v lastlight >/dev/null && echo "installed" || npm i -g lastlight
```

## 2. Get the server URL

Ask the user for the instance URL (e.g. `https://lastlight.example.com`). If they
don't know it, they need it from whoever runs the server.

## 3. Log in

Two paths — pick based on environment:

- **Browser handoff (default, interactive desktop):**
  ```bash
  lastlight login https://lastlight.example.com
  ```
  Opens the dashboard; the user authenticates with whatever method the server
  has (password / Slack / GitHub OAuth) and the token is captured automatically.

- **Headless / no browser (SSH, CI, server box):**
  ```bash
  lastlight login https://lastlight.example.com --password
  ```
  Prompts for the admin password and POSTs it to `/admin/api/login`. Requires the
  server to have `ADMIN_PASSWORD` set.

The token (≈7-day TTL) is saved to `~/.lastlight/config.json`.

## 4. Verify

```bash
lastlight status
```

Confirm: **Server healthy**, **Token valid**. If the token shows
`expired/invalid`, re-run `lastlight login`.

## Overrides & alternatives

- Skip the saved file with env vars or flags (precedence: flags → env → saved
  file → default `http://localhost:8644`):
  ```bash
  LASTLIGHT_URL=https://ll.example.com LASTLIGHT_TOKEN=... lastlight status
  lastlight status --url https://ll.example.com --token ...
  ```
- `lastlight logout` clears the saved config.
- One-shot wizard: `lastlight setup --client` is equivalent to `lastlight login`.

## What you can do once connected

```bash
lastlight chat "hello"                 # chat with the bot (REPL if no message)
lastlight owner/repo#123               # triage an issue (default, cheap)
lastlight build owner/repo#123         # full build cycle
lastlight triage|review owner/repo[#N] # repo scan or single issue/PR
lastlight health|security owner/repo   # repo-level report
lastlight workflow list|log <id>       # inspect runs
lastlight session list|log <id> -f     # tail a sandbox session
lastlight logs search "<text>"         # search errors / transcripts
lastlight approvals list|approve|reject
```

## Done when

`lastlight status` reports the server healthy and the token valid. Report the
connected instance URL and a couple of commands the user can run next.

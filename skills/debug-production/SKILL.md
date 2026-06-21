---
name: debug-production
description: Debug a running Last Light instance (usually production) via the `lastlight` CLI instead of SSH. Use when investigating a failed/stuck workflow, a bad agent run, a phase error, or "why didn't the bot do X" — anything that previously meant SSHing in to read SQLite or session logs.
version: 1.0.0
tags: [ops, debugging, cli]
---

# Debug a Last Light instance via the CLI

Read a running instance's state over its admin API with the `lastlight` CLI —
no SSH, no poking SQLite or jsonl files on the box. Every command takes
`--json` for machine-parseable output; prefer it when you need to extract
fields.

## 0. Connect

The CLI talks to whatever instance you logged into (saved in
`~/.lastlight/config.json`). Confirm you're pointed at the right one and the
token is valid:

```bash
lastlight status            # instance URL, server health, token validity
```

If the token is missing/expired, authenticate (the prod instance URL lives in
local agent memory — see the "Last Light production server" note):

```bash
lastlight login https://<instance>     # browser handoff (password/Slack/GitHub)
lastlight login https://<instance> --password   # headless fallback
```

For one-off targeting without saving, pass `--url` / `--token` on any command,
or set `LASTLIGHT_URL` / `LASTLIGHT_TOKEN` (env wins over the saved config).

## 1. Find the broken run

```bash
lastlight workflow list --status failed          # recent failures
lastlight workflow list --status active          # running + paused now
lastlight workflow list --workflow pr-review --limit 50
```

Copy the run `ID` from the table.

## 2. Inspect the run's phases

```bash
lastlight workflow log <run-id>          # run header + per-phase table (✓/✗, duration, session id, error)
lastlight workflow log <run-id> --follow # then tail the current phase live
```

The phase table shows which phase failed, its error snippet, and the `SESSION`
id you need for the transcript.

## 3. Read / tail the agent transcript

```bash
lastlight session list                   # recent sandbox sessions (TYPE, MODEL, LIVE)
lastlight session log <session-id>       # full transcript
lastlight session log <session-id> --follow   # live tail (SSE) of an in-flight phase
```

## 4. Search across runs

```bash
lastlight logs search "ECONNREFUSED"                 # errors ledger (default)
lastlight logs search "rate limit" --scope all       # errors + transcript content
lastlight logs search "could not clone" --scope messages --limit 20
```

`--scope errors` (default) matches the executions ledger (error/skill/repo);
`messages` greps recent session transcripts; `all` does both.

## 5. Raw server / docker logs

When the workflow + session views aren't enough — a crash before any session
was written, a sidecar misbehaving, harness boot errors — read the actual
container logs (`docker logs`) over the API:

```bash
lastlight server list                    # the lastlight-* containers + status
lastlight server logs                    # the agent harness (default), last 200 lines
lastlight server logs --tail 500 --since 10m
lastlight server logs --follow           # live tail (Ctrl-C to stop)
lastlight server logs coredns-strict     # a specific sidecar by service or container name
```

## 6. Approvals & health

```bash
lastlight approvals list                 # paused gates waiting on a human
lastlight approvals approve <id> --reason "looks good"
lastlight approvals reject  <id> --reason "wrong approach"

lastlight stats                          # totals + per-skill success/fail
lastlight stats --daily 14               # last 14 days of cost/tokens
```

## Tips

- Add `--json` to any command to pipe into `jq` (e.g.
  `lastlight workflow list --status failed --json | jq -r '.workflowRuns[].id'`).
- Triage flow: `workflow list --status failed` → `workflow log <id>` → grab the
  failed phase's session → `session log <session-id>` → if it's a recurring
  symptom, `logs search "<error text>"` to see how often it happens.
- These are read-only except `approvals approve/reject` and the trigger
  commands (`build`/`triage`/`review`/…) — debugging never mutates the box.

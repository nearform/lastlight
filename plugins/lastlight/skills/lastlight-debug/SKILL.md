---
name: lastlight-debug
description: Debug a running Last Light instance over its admin API with the `lastlight` CLI — no SSH. Use when the user wants to "look at / debug a failed or stuck workflow", "why didn't the bot do X", "check a bad agent run / phase error on <instance>", "tail a session", "search the logs", "read the server/docker logs", "list/trigger a cron", "resolve an approval", or "check stats/cost" against a deployed server. Needs a CLI already connected (see lastlight-client to log in). For standing up the server use lastlight-server; for editing config/workflows use lastlight-overlay.
version: 1.0.0
tags: [lastlight, debug, ops, cli, workflows, sessions, logs]
---

# Debug a Last Light instance via the CLI

Read a running instance's state over its admin API with the `lastlight` CLI — no
SSH, no poking SQLite or jsonl files on the box. Every command takes `--json`
for machine-parseable output; prefer it when you need to extract fields.

This is the operator counterpart to **`lastlight-client`** (which logs the CLI
in). If `lastlight status` errors with no saved config, run `lastlight-client`
first.

## 1. Connect

The CLI talks to whatever instance you logged into (saved in
`~/.lastlight/config.json`). Confirm you're pointed at the right one and the
token is valid:

```bash
lastlight status            # instance URL, server health, token validity
```

If the token is missing/expired, log in (`lastlight login https://<instance>`,
or `--password` for headless) — that's the **`lastlight-client`** flow. For
one-off targeting without saving, pass `--url` / `--token` on any command, or
set `LASTLIGHT_URL` / `LASTLIGHT_TOKEN` (env wins over the saved config).

## 2. Find the broken run

```bash
lastlight workflow list --status failed          # recent failures
lastlight workflow list --status active          # running + paused now
lastlight workflow list --workflow pr-review --limit 50
```

Copy the run `ID` from the table. The `PHASE` column names the phase the run is
at (or failed on).

## 3. Inspect the run's phases

```bash
lastlight workflow log <run-id>          # run header + per-phase table (✓/✗/…, duration, session id, error)
lastlight workflow log <run-id> --follow # then tail the current phase live
```

The phase table shows which phase failed, its error snippet, and the `SESSION`
id you need for the transcript. A phase stuck at `…` never finished (still
`started`); a `✗` finished failed.

If it failed on a transient/infra hiccup, re-run from the failed phase:

```bash
lastlight workflow retry <run-id>        # resumes from the phase that failed (same workspace/context)
```

## 4. Read / tail the agent transcript

```bash
lastlight session list                   # recent sandbox sessions (TYPE, MODEL, LIVE)
lastlight session log <session-id>       # full transcript
lastlight session log <session-id> --follow   # live tail (SSE) of an in-flight phase
```

## 5. Search across runs

```bash
lastlight logs search "ECONNREFUSED"                 # errors ledger (default)
lastlight logs search "rate limit" --scope all       # errors + transcript content
lastlight logs search "could not clone" --scope messages --limit 20
```

`--scope errors` (default) matches the executions ledger (error/skill/repo);
`messages` greps recent session transcripts; `all` does both.

## 6. Raw server / docker logs

When the workflow + session views aren't enough — a crash before any session was
written, a sidecar misbehaving, harness boot errors — read the actual container
logs (`docker logs`) over the API:

```bash
lastlight server list                    # the lastlight-* containers + status
lastlight server logs                    # the agent harness (default), last 200 lines
lastlight server logs --tail 500 --since 10m
lastlight server logs --follow           # live tail (Ctrl-C to stop)
lastlight server logs coredns-strict     # a specific sidecar by service or container name
```

## 7. Crons

Scheduled workflows (health scans, PR-review fanout, dependabot merge, …):

```bash
lastlight cron list                      # schedule, next/last run, status
lastlight cron trigger <name>            # run one now (fire-and-forget; handy for repro)
lastlight cron disable <name>            # pause a noisy/broken job (idempotent)
lastlight cron enable  <name>            # re-enable it
```

## 8. Approvals & stats

```bash
lastlight approvals list                 # paused gates waiting on a human
lastlight approvals approve <id> --reason "looks good"
lastlight approvals reject  <id> --reason "wrong approach"

lastlight stats                          # totals + per-skill success/fail
lastlight stats --daily 14               # last 14 days of cost/tokens
lastlight stats --hourly 24              # last 24 hours (spot a spike / stuck loop)
```

## Tips

- Add `--json` to any command to pipe into `jq` (e.g.
  `lastlight workflow list --status failed --json | jq -r '.workflowRuns[].id'`).
- Per-command help is authoritative: `lastlight <cmd> help` (e.g.
  `lastlight cron help`); the bare `lastlight --help` is a compact index.
- Triage flow: `workflow list --status failed` → `workflow log <id>` → grab the
  failed phase's session → `session log <session-id>` → if it's a recurring
  symptom, `logs search "<error text>"` to see how often it happens.
- These are read-only except `approvals approve/reject`, `cron
  enable/disable/trigger`, `workflow retry`, and the trigger commands
  (`build`/`triage`/`review`/…) — plain debugging never mutates the box.

## Done when

You've located the failing run/phase and its cause — named the phase, quoted the
error, and pointed at the session transcript (or server log) that shows it — and,
if asked, kicked off a `workflow retry` or resolved the approval. Report findings
concisely; don't dump whole transcripts.

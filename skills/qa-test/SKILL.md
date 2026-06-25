---
name: qa-test
description: Run an automated QA flow against a CLI or a locally-served app and report step-level pass/fail with evidence. Use when asked to QA-test a feature, exercise a flow end-to-end, or smoke-test what a PR changed.
version: 1.0.0
tags: [github, qa, testing, evidence]
---

# QA Test

Drive a target through a sequence of steps and report **step-level pass/fail**
with evidence for each step. The deliverable is a QA report, not a single
verdict — partial coverage with documented failures is the expected output.

This skill uses the **building** skill for installing dependencies and running
the repo's build/run commands in the sandbox.

> **Scope (text-evidence path).** The sandbox agent has bash, file read, and the
> github tools — no browser, no screenshots. QA a **CLI** directly, or a **web
> service** by starting its dev-server in the background and exercising it with
> `curl` (status codes, response bodies, headers). Capture stdout/stderr, exit
> codes, and log excerpts as per-step evidence. Driving a real browser UI and
> attaching screenshots is a separate docker-gated capability (not available
> here) — for a step that genuinely needs rendered-UI interaction, mark it
> **BLOCKED** with the reason rather than faking a result.

## Parse the target

The Context block gives you what to test and (usually) a PR/issue. The target
may be:

- A **CLI command** (`my-cli --flag`, a subcommand) → run it directly.
- A **local web service** (an app the repo serves on a port) → start it, hit it
  with `curl`.
- A **PR reference + focus area** → read the diff and infer the flow that
  exercises what changed.
- A **free-text flow** ("create a project, then list it") → infer concrete steps.

When a PR/issue is given, read its description + diff (from the local checkout —
see the **building** skill) to decide what's worth testing.

## Define the steps

If the request specifies steps, use them. Otherwise design a reasonable flow:

- **CLI**: invoke with valid input → assert output/exit code → invoke an edge
  case (bad flag, missing arg) → assert it's handled → done.
- **Web service**: start the server → wait until it's ready → hit the primary
  endpoint(s) → assert status + body → hit an error case → assert handling →
  stop the server.

State the steps and their success criteria before running. If the flow or the
success criteria are genuinely ambiguous and you can't infer them from the diff,
say what's unclear in the report rather than inventing a pass.

## Run each step

Follow the **building** skill to install and build first. Then run each step in
order, capturing evidence (command + stdout/stderr + exit code) at every step.

- **Record each step's result as you go** — PASS, FAIL, or BLOCKED.
- **On failure, continue to the next step** for maximum coverage — *unless* the
  failure blocks everything downstream (e.g. the server never starts, or a login
  step fails). If it's a hard blocker, record it, mark the rest BLOCKED, and stop.
- Treat a wrong result as a real finding, not your mistake. Don't edit the code
  under test to make a step pass.

## Report

Produce your report as your **final message** in this shape — the workflow posts
it for you (don't `github_add_issue_comment` yourself; that would double-post):

```
## QA Test: <target>

**Environment:** <branch / commit, package manager, how the app was run>

### Results
| Step | Status | Evidence |
|------|--------|----------|
| <step description> | PASS / FAIL / BLOCKED | <command + key output / exit code> |

### Issues found
- <each FAIL with the expected vs observed behaviour and the evidence>

### Coverage
<what was tested, and what was not tested and why (e.g. a UI-only step that the
text-evidence sandbox can't drive).>
```

Every defined step must have a row and a result. Never report a flow as
"passed" with steps you didn't actually run — list them as untested instead.

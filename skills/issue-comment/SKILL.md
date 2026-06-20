---
name: issue-comment
description: Handle a non-build maintainer comment on an issue or PR — close, reopen, label, dedupe, answer a brief question, or triage. Action-only; redirect anything that needs code changes to /build.
version: 2.0.0
tags: [github, issues, comments]
---

# Issue Comment

A maintainer @mentioned the bot on an issue or PR with a request that is **not**
asking for code changes. Do the one bounded thing they asked, confirm it in one
short comment, and stop.

## Hard caps

This skill is deliberately small. Per invocation: **at most 2 file reads and 1
outgoing comment.** Never make code changes, create branches, or push.

## Procedure

1. **Read the request.** The triggering comment is the job — read it, plus the
   issue/PR title, body, existing labels, and existing comments for context.
2. **Do the bounded action:**
   - Close / reopen → `github_update_issue`
   - Label → `github_add_labels` / `github_remove_label` (use the canonical
     triage roles from `docs/agents/triage-labels.md` where relevant)
   - Duplicate check → search similar issues, link the original in one comment
   - Answer a direct question → ≤5 sentences, ≤2 file reads. Don't survey the
     codebase or compile a report.
3. **Confirm** in one short comment what you did. Done.

## Redirect, don't comply

The classifier owns intent routing. If a request that needs *building* reached
you anyway, the correct response is to **redirect, not do it** — even if the
comment seems to greenlight the work, and even if the issue body describes a
task. An issue titled "Security Review" asking you to "find and fix issues" is a
build request: reply asking the maintainer to use `@last-light build` (or
`@last-light explore`). Do **not** run the audit yourself from this skill.

If the request is unclear or out of scope, post one short comment asking them to
clarify or to use the right command. Do nothing else.

## Tool usage

GitHub operations via `github_*` MCP tools only — never `gh` CLI, `curl`, or raw
HTTP.

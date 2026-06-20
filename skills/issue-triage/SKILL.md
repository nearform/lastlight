---
name: issue-triage
description: Triage GitHub issues through the canonical state machine — classify, label, deduplicate, request missing info, write agent briefs, and manage stale issues. Use on demand or on a triage cron.
version: 2.0.0
tags: [github, issues, triage]
---

# Issue Triage

Move each issue through a small **state machine**. Every triaged issue carries
exactly **one category role and one state role**:

- **Category:** `bug` (something is broken) · `enhancement` (new feature or improvement)
- **State:** `needs-triage` (awaiting evaluation) · `needs-info` (waiting on the
  reporter) · `ready-for-agent` (fully specified, an AFK agent can take it) ·
  `ready-for-human` (needs human implementation) · `wontfix` (won't be actioned)

These are canonical role names; the actual label strings for a repo may differ —
`docs/agents/triage-labels.md` holds the mapping when present. Run **autonomously**:
there is no maintainer to ask mid-run. Where you'd want direction, either make
the call and apply the label, or post a comment and stop — the async comment *is*
the conversation.

## 0. Ensure the labels exist

Before applying any label, create the canonical set idempotently with
`github_create_label` (ignore 422 "already exists"):

| Label | Color | Role |
|-------|-------|------|
| `bug` | `d73a4a` | category |
| `enhancement` | `a2eeef` | category |
| `needs-triage` | `ededed` | state |
| `needs-info` | `fbca04` | state |
| `ready-for-agent` | `0e8a16` | state |
| `ready-for-human` | `1d76db` | state |
| `wontfix` | `ffffff` | state |
| `duplicate` | `cfd3d7` | dedupe |
| `question` | `d876e3` | question |

If label creation is denied (the token lacks the permission), fall back to using
only the labels that already exist on the repo and skip the rest. Done when the
labels you need are present or you've confirmed you can't create them.

## 1. Triage a specific issue

1. **Gather context.** Read the full issue — title, body, comments, existing
   labels, author, dates. Search existing issues for **duplicates** by concept
   (not just keyword). If a `.out-of-scope/` directory exists, read it and note
   any prior rejection this resembles. Done when you know the issue's intent and
   whether it's novel.
2. **Classify the category** — `bug` or `enhancement`. But first, check whether
   the issue is a **question** at all (see below) — questions are neither.
3. **Decide the state and act** (exactly one applies):
   - **Question** (asks for information, an explanation, or a comparison — wants
     an answer, not a code change) → add `question` and **stop**. Do **not**
     write an agent brief or mark it `ready-for-agent`/`ready-for-human` — a
     pure question is not work. (The router normally sends these to the answer
     path before triage runs; this is the safety net for ones that slip
     through, e.g. reopened issues. If you can answer it briefly and factually
     from the repo itself, do so in one short comment; otherwise just label it
     and leave it for the answer path or a human.)
   - **Duplicate** → comment linking the original, add `duplicate`, close.
   - **Already implemented** → comment pointing to where it lives, add `wontfix`,
     close. (Factual — safe to close autonomously.)
   - **Under-specified** (bug without repro, feature without a use case) → add
     `needs-info`, post the [needs-info template](#needs-info-template), stop.
   - **Fully specified and delegatable** → add `ready-for-agent`, post an agent
     brief ([references/AGENT-BRIEF.md](references/AGENT-BRIEF.md)).
   - **Needs human implementation** (judgment calls, external access, design
     decisions, manual testing) → add `ready-for-human` with a brief noting why
     it can't be delegated.
   - **Looks out of scope** (an enhancement you'd reject) → this is a maintainer
     decision; do **not** auto-close. Add `needs-triage`, post a comment with
     your reasoning (cite any matching `.out-of-scope/` file), and leave it for a
     human.
4. **Apply exactly one category + one state.** If the existing labels conflict
   (two state roles), flag it in a comment and don't override — a maintainer may
   have set them deliberately.

## 2. New unlabelled issues (batch / cron)

For each issue with no triage labels yet, run §1. Default new issues that need
evaluation to `needs-triage`.

## 3. Stale `needs-info`

1. Find issues labelled `needs-info` with no activity for **14+ days**.
2. **Check for a prior bot reminder** with `github_list_issue_comments` — look
   for a `last-light[bot]` comment containing "reminder" / "still need" /
   "closing". **Never post a duplicate reminder.**
3. No reminder yet → post a gentle reminder asking if they still need help.
4. Reminder exists and **30+ days** have passed with no reporter response since →
   close kindly, noting they can reopen.
5. Reminder exists, **< 30 days** since → do nothing.

## needs-info template

```markdown
## Triage Notes

**What we've established so far:**
- point 1

**What we still need from you (@reporter):**
- specific, actionable question 1
```

Questions must be specific and actionable — not "please provide more info".

## Tool usage

GitHub operations via `github_*` MCP tools only — listing, labelling, commenting,
closing, creating labels. Never `gh` CLI, `curl`, or raw HTTP.

## Pitfalls

- Don't close aggressively — when genuinely in doubt, leave it open as `needs-triage`.
- Don't change priority or state on issues a maintainer already triaged.
- Check existing labels before adding — don't duplicate.

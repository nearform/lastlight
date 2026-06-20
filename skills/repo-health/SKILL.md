---
name: repo-health
description: Generate a health report for a GitHub repository — open-issue and PR backlog, unreviewed PRs, stale needs-info, failing CI, and the resulting action items. Use for a status report or on a weekly cron.
version: 2.0.0
tags: [github, monitoring, reporting]
---

# Repo Health

Produce a point-in-time health snapshot of a repo and the action items it
implies. One report per run.

## Procedure

### 1. Gather metrics

Pull these via `github_*` MCP tools. Done when each number below is filled.

- **Open issues** — total, and a breakdown by the repo's own priority/severity
  labels *if it uses any* (don't assume a fixed scheme).
- **Open PRs** — total, and how long each has been open. Exclude drafts from any
  "awaiting review" count.
- **Unreviewed PRs** — open, non-draft, no reviews yet.
- **Stale `needs-info`** — issues labelled `needs-info` with no activity for 14+ days.
- **Recent throughput** — issues closed and PRs merged in the last 7 days.

Batch requests and don't fetch full history — rate limits bite on large repos.

### 2. Derive action items

Each is a checkbox line with the number and the reason:

- PRs open > 7 days with no review.
- High-priority issues still open (by whatever priority labels the repo uses).
- `ready-for-agent` issues sitting unactioned (agent backlog).
- Stale `needs-info` (14+ days).
- PRs with failing CI.

### 3. Render the report

```markdown
## Repo Health: {owner}/{repo} — {YYYY-MM-DD}

### Overview
- Open issues: {X} ({breakdown by the repo's priority labels, if any})
- Open PRs: {X} ({Y} awaiting review)
- Merged this week: {X} PRs · Closed this week: {X} issues

### Action items
- [ ] PR #123 — open 12 days, no review
- [ ] Issue #456 — high priority, open 3 days
- [ ] Issue #789 — needs-info, stale 21 days

### Trends
- Issue velocity: +{X} opened, −{Y} closed (net {±Z})
```

Omit a section that has nothing in it rather than printing "none".

### 4. Deliver

Output the report as the final response. The harness routes it (direct display
interactively, or to the configured channel on a cron run).

## Verification

Spot-check 2–3 of the reported numbers against the GitHub UI before delivering.

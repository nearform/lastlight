---
name: pr-review
description: Review a GitHub pull request with structured feedback following project guidelines
version: 2.0.0
tags: [github, review, code-quality]
---

# PR Review Skill

## When to Use
When asked to review a pull request, or when triggered by a webhook/cron to check for unreviewed PRs.

## Procedure

### Workspace setup

For pr-review runs the harness pre-clones the PR's head ref into a
`<repo>/` **subdirectory** of your cwd. The cwd itself is the workspace
root (contains `AGENTS.md`); the cloned repo is one level deeper.

```
ls -la         # do you see <repo>/.git/ in the listing?
```

- If yes — `cd <repo>` and use git directly. To refresh:
  ```
  git fetch origin <branch> --depth 50
  git reset --hard FETCH_HEAD
  ```
- If no — the pre-clone failed. Clone into the subdir yourself:
  ```
  git clone https://github.com/{{owner}}/{{repo}}.git {{repo}}
  cd {{repo}}
  ```

### Target selection

The runner provides PR context vars. Use them in this order:

1. If `prNumber` (or `issueNumber`) > 0 is set in the Context block below, that is your target PR. Go straight to `github_get_pull_request` with that number — do NOT call `github_list_pull_requests` first.
2. Only if no specific PR is provided, list open PRs in the repo and pick the most recent unreviewed one. When calling `github_list_pull_requests`, omit any filter you don't actually want — never pass empty strings like `head: ""` or `base: ""`, those become literal filters that return nothing.

### 0. Read prior discussion

Before reviewing, fetch the full conversation history. **Do not skip this step** — the goal of a review is to advance the discussion, not restart it.

1. `github_get_pull_request` — head SHA, mergeable state, author, base/head refs.
2. `github_list_pull_request_reviews` — every prior review (APPROVED / CHANGES_REQUESTED / COMMENTED).
   - If a review from `last-light[bot]` exists on the **current head SHA**, STOP — do not post a duplicate. (A re-review is fine if new commits landed since.)
3. `github_list_issue_comments` — top-level conversation thread on the PR.
4. `github_list_pull_request_review_comments` — line-level review comments anchored to diff positions.

Build a mental model of what's already been said:
- Which findings did prior reviewers raise? Don't repeat them.
- Which threads did the author address (with a follow-up commit or explanation)? Treat as resolved unless their fix is wrong.
- Which threads are still open / unaddressed? Surface those in your summary — that's higher signal than a fresh-eyes nit.
- Has a human reviewer already approved? Lower your bar for blocking — APPROVE or COMMENT, don't REQUEST_CHANGES on style.

Skip PRs authored by `last-light[bot]` (self-review).

### 1. Fetch PR metadata

Using MCP tools:
- Get the PR title, description, labels, and linked issues (from step 0 you already have most of this)
- Get the list of changed files (`github_list_pull_request_files`) and the diff (`github_get_pull_request_diff`)

### 2. Analyze the changes

- Read each changed file in context (not just the diff)
- Check against the review guidelines in your agent context
- Note the PR size (files changed, lines added/removed)

**For complex PRs** (>300 lines changed OR >5 files changed):
- Clone the repo locally and read changed files in FULL context
- Trace data flow through modified functions
- Check callers of modified functions for regression risk
- Check if tests cover actual risk areas, not just happy paths

### 3. Categorize findings

- **Critical**: Security issues, data loss, breaking changes — block merge
- **Important**: Missing tests, perf issues, type errors — should fix
- **Suggestions**: Clarity, naming, DRY opportunities — nice to have
- **Nits**: Style, formatting — optional

### 4. Write the review comment

- 1-2 sentence summary of what the PR does
- Findings grouped by tier, with file:line references
- Inline code suggestions where helpful
- For complex PRs: impact analysis (affected code paths, regression risks)
- Overall assessment: approve, request changes, or comment
- Thank the contributor

### 5. Submit the review

Use `github_create_pull_request_review` MCP tool. Do NOT post as a regular comment.

## Tool Usage

**Always use the github MCP server tools** (`github_*`) for all GitHub operations. Never use `gh` CLI, `curl`, or raw HTTP requests.

## Pitfalls
- **Never review the same PR twice** at the same commit — always check first
- Don't nitpick generated files (lock files, compiled assets)
- Don't repeat what linters/CI already catch
- Don't block PRs over style preferences alone
- Skip PRs authored by the bot itself

## Verification
- Confirm the review was posted by checking the PR reviews list

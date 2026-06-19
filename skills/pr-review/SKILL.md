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

**Only the source is pre-cloned — dependencies are NOT installed** (no
`node_modules` etc.). A diff-only read doesn't need them. But if the PR's
correctness depends on it building or tests passing, install first and verify —
see "Verify by building" in step 2.

### Target selection

The runner provides PR context vars. Use them in this order:

1. **If `prNumber` (or `issueNumber`) > 0 is set in the Context block below, that IS your target PR — you already know it.** Go straight to `github_get_pull_request` with that number. Do **NOT** call `github_list_pull_requests` to "find" or "confirm" the PR — you are not searching for it, you were handed it. Listing PRs here is pure waste: it returns a large payload that bloats every later turn and tells you nothing you didn't already have.
2. Only if **no** specific PR is provided (e.g. a repo-wide `mode: scan` run) do you list open PRs and pick the most recent unreviewed one. When calling `github_list_pull_requests`, omit any filter you don't actually want — never pass empty strings like `head: ""` or `base: ""`, those become literal filters that return nothing. **Skip any PR authored by the bot itself** (`last-light[bot]`) — never self-review.

### 0. Read prior discussion

Before reviewing, fetch the full conversation history. **Do not skip this step** — the goal of a review is to advance the discussion, not restart it.

1. `github_get_pull_request` — head SHA, mergeable state, author, base/head refs.
   - **If `merged` is true, STOP.** This skill only reviews open PRs. The formal-review endpoint (`github_create_pull_request_review`) returns 403 on merged PRs for App installations, and a post-merge review has no gating value. If a maintainer wants commentary on a merged PR, they should use the pr-comment skill instead.
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

### 1. Get the diff — from your LOCAL checkout, not the API

The PR's code is already checked out at `<repo>/` (see Workspace setup). That
checkout is the source of truth for the diff and the file contents — use it.
`github_get_pull_request` (step 0) gave you the base and head refs. From inside
`<repo>/`:

```
git fetch origin <baseRef> --depth 50    # base isn't in the shallow head-only clone
git diff --stat origin/<baseRef>...HEAD  # changed files + churn
git diff origin/<baseRef>...HEAD         # the full patch
```

Do **NOT** call `github_list_pull_request_files` or
`github_get_pull_request_diff`. Pulling the patch over the API duplicates what's
already on disk and drops a large payload into the context that you then re-read
on every subsequent turn — it's the single biggest avoidable cost in a review.
Read each changed file in full from the same local checkout (your `read`/`grep`
tools operate on it directly), not via `github_get_file_contents`.

You already have the PR title, description, labels, and linked issues from
step 0 — don't re-fetch them.

### 2. Analyze the changes

- Read each changed file in context (not just the diff)
- Check against the review guidelines in your agent context
- Note the PR size (files changed, lines added/removed)

**For complex PRs** (>300 lines changed OR >5 files changed):
- Read changed files in FULL context from the local checkout (it's already there — don't clone again)
- Trace data flow through modified functions
- Check callers of modified functions for regression risk
- Check if tests cover actual risk areas, not just happy paths

#### Verify by building

When the PR's correctness depends on it compiling, type-checking, or tests
passing — build config, type/export changes, packaging, non-trivial logic — do
NOT just reason statically. Build and run, then report real results.

Dependencies are not pre-installed, so install them first. Detect the package
manager from the lockfile and use the frozen/CI variant:
- `package-lock.json` → `npm ci`
- `pnpm-lock.yaml` → `corepack pnpm install --frozen-lockfile`
- `yarn.lock` → `corepack yarn install --frozen-lockfile`

Then run the project's own build/test commands (check `package.json` scripts /
CI config) and cite the actual output in your findings. The sandbox egress
allowlist permits the public package registries, so install will work.

Skip this for pure style/docs PRs — installing just to nitpick formatting is
wasted effort. If you genuinely can't verify (e.g. install fails), say so
explicitly and scope your review to what you *could* check — don't imply you
verified something you didn't.

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

**Use the github MCP server tools** (`github_*`) for GitHub *API* operations — reading PR metadata/comments and posting the review. Never use `gh` CLI, `curl`, or raw HTTP for those.

The one deliberate exception is the **diff and file contents**: those come from your local `<repo>/` checkout via plain `git`/`read`/`grep` (see step 1), not from `github_*_diff` / `github_list_pull_request_files` / `github_get_file_contents`. Local git on the pre-cloned repo is preferred there because the API patch is a large redundant payload.

## Pitfalls
- **You already know the target PR** when `prNumber` is set — never call `github_list_pull_requests` to find or confirm it (step "Target selection").
- **Use the local checkout for the diff** — don't pull the patch via `github_list_pull_request_files` / `github_get_pull_request_diff` (step 1).
- **Never self-review.** Skip any PR authored by `last-light[bot]`. (Webhook-triggered runs are already filtered out before they reach you; this guards the `mode: scan` path.)
- **Never review the same PR twice** at the same commit — always check first
- Don't nitpick generated files (lock files, compiled assets)
- Don't repeat what linters/CI already catch
- Don't block PRs over style preferences alone

## Verification
- Confirm the review was posted by checking the PR reviews list

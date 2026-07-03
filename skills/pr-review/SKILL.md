---
name: pr-review
description: Review a GitHub pull request and post one formal review — advance the existing discussion and give precision-first, high-signal feedback. A pure code review — no building. Use when asked to review a PR or on a cron PR scan.
version: 5.0.0
tags: [github, review, code-quality]
---

# PR Review

Review an open PR and post **one formal review** — high-signal findings only.
This is a **pure code review**: read the change and reason about it. Do **not**
install dependencies, build, or run tests — that is CI's job, and it validates
whether the change actually works far more reliably than you re-running it here.
Your job is judgement on the diff, not a build gate. A noisy review gets muted,
so precision matters more than volume.

This skill is the PR-specific procedure. It uses the **code-review** skill for
the precision bar and what-to-check rubric.

## Workspace

The harness pre-clones the PR's head ref into a `<repo>/` **subdirectory** of
your cwd (the cwd holds `AGENTS.md`; the repo is one level deeper). `ls -la` —
if you see `<repo>/.git/`, `cd <repo>` and use git directly. To refresh:
`git fetch origin <branch> --depth 50 && git reset --hard FETCH_HEAD`. If the
pre-clone is missing, `git clone https://github.com/{{owner}}/{{repo}}.git {{repo}}`.

**Read code from this local checkout, never the API.** Use `git`/`read`/`grep`
on disk for the diff and file contents. Do **not** call
`github_get_pull_request_diff`, `github_list_pull_request_files`, or
`github_get_file_contents` — the API patch is a large redundant payload that
re-bloats context every turn. The `github_*` tools are for *API* operations only
(metadata, comments, posting the review).

## Procedure

### 1. Confirm the target

If `prNumber` (or `issueNumber`) is set in the Context block, **that is your
target** — go straight to `github_get_pull_request` with it. Do **not** call
`github_list_pull_requests` to "find" or "confirm" it; you were handed it, and
listing dumps a large payload for nothing. Only when no PR is given (a repo-wide
`mode: scan`) do you list open PRs and pick the most recent unreviewed one.

**Stop conditions** (check before reviewing):
- PR authored by `last-light[bot]` → skip. Never self-review.
- `merged === true` → stop. This skill reviews open PRs only.
- A `last-light[bot]` review already exists on the **current head SHA** → stop;
  don't post a duplicate. (A re-review is fine once new commits land.)

### 2. Read the prior discussion

A review advances the conversation, don't restart it. Fetch and absorb:
`github_list_pull_request_reviews`, `github_list_issue_comments`,
`github_list_pull_request_review_comments`. Done when you can say: which findings
were already raised (don't repeat them), which threads the author resolved
(treat as done unless the fix is wrong), which are still open (surface those —
higher signal than a fresh nit), and whether a human already approved.

### 3. Get the diff

From inside `<repo>/`:
```
git fetch origin <baseRef> --depth 50      # base isn't in the head-only clone
git diff --stat origin/<baseRef>...HEAD    # churn
git diff origin/<baseRef>...HEAD           # the patch
```

### 4. Assess and submit

Apply the **code-review** skill's rubric — read each changed file in context;
check correctness / edge-cases / security / regression-risk / test-coverage.
Reason about the code statically; **don't build or run it** — trust CI to catch
what only running reveals, and spend your effort on what a human reviewer sees.
Follow that skill's **precision-first** rule: post **only Critical and Important**
findings, each with a `path:line` reference and a one-line concrete impact (what
breaks, for which input or caller) plus an inline code suggestion where it helps.
Drop Suggestions and Nits.

Before submitting, run the **confidence gate**: re-read each finding against the
actual code and try to refute it; drop any you can't defend against what the code
really does. A clean PR should be approved with few or no comments — that is a
good review, not a lazy one.

Then write the review:

- One or two sentences on what the PR does.
- The surviving Critical/Important findings, each with its `path:line` + impact.
- For a complex PR, an impact note (affected paths, regression risks).
- An overall assessment, and thanks to the contributor.

Submit with `github_create_pull_request_review` (a **formal** review, not a plain
issue comment), event `APPROVE` / `REQUEST_CHANGES` / `COMMENT` to match what
survived the gate.

## Verification

Confirm the review posted by checking the PR's reviews list.

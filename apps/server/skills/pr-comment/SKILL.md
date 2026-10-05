---
name: pr-comment
description: Answer a maintainer's question about an open PR with concrete, code-cited evidence. The PR-side counterpart to issue-comment — for questions tied to the diff, not a full review.
version: 2.0.0
tags: [github, pr, comments, qa]
---

# PR Comment

A maintainer @mentioned the bot on a PR with a *question* (not a request to
write code, and not "review this"). The question is the entire job — answer it
with evidence, in one comment. Examples: "does this consider X?", "why did we
change Y?", "is the new function thread-safe?", "regression risk for existing
callers?".

For general issue questions use `issue-comment`; for a full review use
`pr-review`.

## Procedure

### 1. Read the PR and the question

- `github_get_pull_request` → title, body, base, head. `prNumber` in the Context
  block **is** your target — go straight there. Do **not** call
  `github_list_pull_requests` to "find" or "confirm" it; you were handed it, and
  listing dumps every open PR for nothing.
- The triggering question is in `context.commentBody`. Answer *that* question —
  don't generalise to a review or answer a different one.

### 2. Investigate with the diff in hand

Get the diff and read the code needed to answer well — a real answer about
thread-safety or regression risk needs the surrounding code, not just the hunk.

- **Cap: 8 file reads** per invocation.
- "Does it consider X?" → also check whether tests in the diff cover X.
- "Regression risk?" → find callers of any function whose signature/behaviour
  changed (`github_search_code`).
- Don't clone the repo unless a single answer genuinely needs cross-file traces
  no MCP tool can give — most don't. If it truly needs a full audit, say so and
  recommend `<botMention> review` (which routes to `pr-review`) rather than blowing the cap.

### 3. Reply with one comment

`github_add_issue_comment` (PRs accept issue comments here). Keep it tight:

- **Lead with the answer** — yes / no / it depends. Don't bury it.
- **Cite `path:line`** — clickable in the GitHub UI.
- 3–8 sentences or a short bulleted list. No headings.
- If it's unanswerable from the PR alone, say so and name the specific
  information you'd need.

## What the bot can and can't do on a PR

Maintainers ask about this in comments, so state it from these facts — never
improvise a limitation. `botMention` in the Context block is this deployment's
handle; use it in every command you suggest, never a hardcoded name.

- **It does approve PRs — through a review.** `pr-review` posts an `APPROVE`
  when it finds nothing to raise, no finding from an earlier review is still
  open, and no human has an open change request; otherwise it posts a
  `COMMENT`. Never say the bot "doesn't approve PRs" or that approval is
  outside what it does.
- **If the question is "can you approve / re-review this?"** — you are not the
  workflow that does it, so don't post a review. Read the bot's own latest
  review (`github_list_pull_request_reviews`: its state and the commit it was
  on vs the current head), say what it was and why it was not an approval if
  that is visible (open findings, "Still open", a human's change request),
  and tell them `<botMention> review` runs a fresh review that approves if
  it comes back clean.
- **Commands it acts on** (maintainers only): `<botMention> review`,
  `<botMention> build` / a fix request (pushes fixes to this PR),
  `<botMention> retry [reason]`, `<botMention> verify <claim>`,
  `<botMention> qa-test <flow>`, `<botMention> demo`,
  `<botMention> security-review`. `<botMention> approve` / `reject` resolve a
  workflow's pending approval gate; on a PR with no gate waiting, `approve`
  runs a review.
- **It doesn't** push to the PR, label, or merge from this skill. If you are
  unsure whether something is possible, say so rather than guessing.

> Yes — `src/foo.ts:42` checks `X` before calling `bar()`, and
> `tests/foo.test.ts:118` asserts the rejection path. The only place X isn't
> validated is the legacy `barLegacy` (`src/foo.ts:67`), which this PR doesn't
> touch — worth a separate issue if you want it covered.

## Do not

- Post a formal review (`github_create_pull_request_review`) — that's
  `pr-review`'s job and would collide with its blocking check.
- Modify code, push, or add labels. One comment, nothing else.
- Answer a tangent you noticed — note it in at most one trailing sentence.

## Tool usage

GitHub operations via `github_*` MCP tools only — never `gh` CLI, `curl`, or raw HTTP.

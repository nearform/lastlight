---
name: adjudicate-pass
description: The shared rules for the ADJUDICATE pass of a multi-pass PR review — the workspace layout, the severity vocabulary it ranks on, and the prior-review ledger plus the two APPROVE constraints it inherits as the only pass that owns the posted verdict. Use when turning a pile of hypotheses into one ranked, tiered review. Not for producing a review from a diff.
version: 1.0.0
tags: [review, adjudicate, multi-pass]
---

# Adjudicate pass

You are the **last pass of a multi-pass review**, and the only one that owns the
verdict a human will read. Your prompt carries the procedure — what to read, the
deletion rule, how to rank and tier, the output schema and the conservation gate.
This skill carries the three things that procedure assumes and does not state.

## What you are not

You are not reviewing a diff. Three procedures belong to a pass that *does*, and
none of them is yours:

- **Confirming the target.** The PR, the head SHA and the question of whether an
  already-reviewed head deserved another look were all settled before you were
  dispatched. Re-deciding any of them can only overturn a decision made with more
  information than you have.
- **`skip`.** A pass reviewing a diff may write `{"skip": true}` and stop. You may
  not. By the time you run, five survey families and an oracle have already been
  paid for; skipping discards all of it and posts nothing.
- **Discovering defects.** You merge, rank, tier and demote claims *other passes
  made*. You read code to check a claim's evidence — never to find a sixth thing.
  A finding you author yourself carries no hypothesis id and answers to no
  obligation, so nothing downstream can tell it from one that was verified.

## Workspace

The harness pre-cloned the PR's head ref and dropped you **inside the checkout** —
your cwd **is** the repo (`ls -la` shows `.git/` directly). Use `git` / `read` /
`grep` from here.

**Every `.lastlight/…` path in your prompt is relative to that cwd — use it
relative, never absolute.** The skill files you were handed are absolute paths
under `…/.lastlight-skills/`, and that directory is a **sibling of the checkout,
one level above you**. Joining a `.lastlight/…` path onto the directory your
skills came from lands outside the repo and reads nothing. Measured, not
hypothetical: it cost 23 of 120 survey branches their seeded obligations across
three runs.

**Read code from this local checkout, never the API.** Do not call
`github_get_pull_request_diff`, `github_list_pull_request_files` or
`github_get_file_contents` — the API patch is a large redundant payload that
re-bloats context every turn, and the diff is already staged on disk under
`.lastlight/pr-review/diff/`.

**The `github_*` tools are for API metadata only** — and unlike a survey pass you
genuinely need them, for the prior discussion below. Reviews and comments exist
nowhere on disk. You never submit the review yourself: you rewrite
`findings.json` and a deterministic step posts it.

## Severity vocabulary

Your prompt ranks on `severity` and spends the inline budget in that order, but
the tiers are defined here. Every finding you keep is one of exactly two:

- **Critical** — data loss, a breaking change, silent data-dropping, or a
  security issue that crosses a trust boundary. Blocks merge.
- **Important** — missing tests, performance problems, type errors, avoidable
  duplication, excessive complexity, compiler-silencing assertions. Should fix.

There is no third value. `Suggestion` and `Nit` are tiers a *reviewer* drops
before posting; a claim that thin reaches you as something to file at `internal`
tier, not as a severity.

**`Critical` needs a trust boundary, not a category** — your prompt carries that
predicate, the demotion rule and the measurement behind it. Apply it there. What
this section settles is only the vocabulary: an unrecognised severity (`High`,
`Major`, `Blocker`) ranks as `Important` by fallback and produces a review that
looks ordinary while ordering wrongly.

## The prior review is yours to reconcile

You own the `event` and the `summary`, so two constraints that belong to whoever
posts now belong to you. Establish the prior state first —
`github_list_pull_request_reviews`, `github_list_issue_comments`,
`github_list_pull_request_review_comments`:

- **Never `APPROVE` over an open human `CHANGES_REQUESTED`** — their latest review
  on this PR, not dismissed and not replaced by a later approval from the same
  person. Downgrade to `COMMENT`, and say which of their points the current diff
  addresses and which it does not. A bot APPROVE stacked on an open human block
  reads as an override of somebody who knows the codebase better than you.
- **A human APPROVE lowers the bar for blocking** — prefer `COMMENT` over
  `REQUEST_CHANGES` on anything non-critical.

### If we have reviewed this PR before

You have whenever the reads above turn up a `last-light[bot]` review at an earlier
SHA. A re-review is **not** "what changed since last time"; it is a fresh verdict
on the whole current diff, with the prior findings as its starting point rather
than as settled history.

Every finding in that earlier review lands in exactly one of four buckets, and the
`summary` opens with that ledger, one line each:

- **Fixed** — you re-read the code at `path:line` *as it is now* and the problem is
  genuinely gone. Not "the author replied that they fixed it", not "the thread is
  resolved", not "a commit message says so". Re-read it.
- **Still open** — it reaches the review again. A finding that survives a round
  trip is higher signal than anything new, not lower.
- **Pinned by a test** — the change added or edited a test asserting the *current,
  wrong* behaviour. That is not a fix; it is the bug made permanent. The original
  finding stands and the test is its own `Critical`/`Important` finding, quoting
  the assertion.
- **Withdrawn** — it was wrong. Name what refuted it.

**Never `APPROVE` while one of our own prior findings is still open**, including
one the change only "fixed" by pinning it with a test.

A re-review whose summary is interchangeable with the first one had nothing to
say, and that ledger is what makes the second review worth its cost.

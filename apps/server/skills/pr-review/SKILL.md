---
name: pr-review
description: Review a GitHub pull request and post one formal review — advance the existing discussion and give precision-first, high-signal feedback. A pure code review — no building. Use when asked to review a PR or on a cron PR scan.
version: 7.2.0
tags: [github, review, code-quality]
chat: true
---

# PR Review

Review an open PR — high-signal findings only. This is a **pure code review**:
read the change and reason about it. Do **not** install dependencies, build, or
run tests — that is CI's job, and it validates whether the change actually works
far more reliably than you re-running it here. Your job is judgement on the diff,
not a build gate. A noisy review gets muted, so precision matters more than
volume.

You do **not** post the review yourself. You write your findings to a JSON file
(`.lastlight/pr-review/findings.json`) and a deterministic follow-up step posts
one formal review, anchoring each finding to its diff line as an inline comment
(§5).

This skill is the PR-specific procedure. It uses the **code-review** skill for
the precision bar and what-to-check rubric.

## Workspace

The harness pre-clones the PR's head ref and drops you **inside the checkout** —
your cwd **is** the repo (`ls -la` shows `.git/` directly; `AGENTS.md` is the
sibling one level up at `../`). Use `git`/`read`/`grep` from here. To refresh:
`git fetch origin <branch> --depth 50 && git reset --hard FETCH_HEAD`. If the
checkout is somehow missing, `git clone https://github.com/{{owner}}/{{repo}}.git .`.

**Read code from this local checkout, never the API.** Use `git`/`read`/`grep`
on disk for the diff and file contents. Do **not** call
`github_get_pull_request_diff`, `github_list_pull_request_files`, or
`github_get_file_contents` — the API patch is a large redundant payload that
re-bloats context every turn. The `github_*` tools are for *API* operations only
(reading metadata + prior comments in §1–2). You never post the review via a
tool — you write the findings file and the follow-up step posts it.

## Procedure

### 1. Confirm the target

`prNumber` (or `issueNumber`) in the Context block **is your target** — go
straight to `github_get_pull_request` with it. Do **not** call
`github_list_pull_requests` to "find" or "confirm" it; you were handed it, and
listing dumps a large payload for nothing.

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
higher signal than a fresh nit), and what the humans' review states are.

**Two states change what you're allowed to conclude:**

- A **human APPROVE** lowers the bar for blocking — prefer COMMENT over
  REQUEST_CHANGES on anything non-critical.
- An **open human `CHANGES_REQUESTED`** (their latest review on this PR, not
  dismissed and not replaced by a later APPROVE from the same person) means your
  `event` **must not be `APPROVE`** — use `COMMENT`, or `REQUEST_CHANGES` if you
  have your own blocking finding. Say in the summary which of their points the
  current diff addresses and which it doesn't. A bot APPROVE stacked on top of
  an open human block is the review reading as an override of a person who knows
  the codebase better than you.

### 2b. If you have reviewed this PR before — re-derive, don't assume

You have already reviewed this PR whenever §2 turned up a `last-light[bot]`
review at an earlier SHA. A re-review is **not** "what's new since last time";
it is a fresh verdict on the whole current diff, and the prior findings are its
starting point rather than settled history.

For **every** finding in your previous review, work out which of these it is and
say so in the summary:

- **Fixed** — you re-read the code at `path:line` *as it is now* and the problem
  is genuinely gone. Not "the author replied that they fixed it", not "the
  thread is resolved", not "a commit message says so". Re-read it.
- **Still open** — re-raise it as a finding. A finding that survives a round trip
  is higher signal than anything new you might find, not lower.
- **Pinned by a test** — the change added or edited a test that asserts the
  *current, wrong* behaviour. That is not a fix; it is the bug made permanent.
  Re-raise the original finding and flag the test as its own Critical/Important
  finding, quoting the assertion.
- **Withdrawn** — you now believe the finding was wrong. Name what refuted it.

Only once every prior finding lands in one of those four may you approve.
"Nothing new since the last push" is not a review; if the current diff still
contains a problem you raised, the correct `event` is still
`REQUEST_CHANGES`/`COMMENT`, whoever pushed last.

### 3. Get the diff

From inside `<repo>/`:
```
git fetch origin <baseRef> --depth 50      # base isn't in the head-only clone
git diff --stat origin/<baseRef>...HEAD    # churn
git diff origin/<baseRef>...HEAD           # the patch
```

### 4. Read what CI said

Your Context block carries `checksState` — `passing` / `failing` / `pending` /
`none` — for this PR's head commit, and when it is `failing`, `ciSection` holds
the actual failure report (job, step, log excerpt). **CI has already run: do not
speculate about whether this builds.**

- `checksState: passing` — the change compiles and the tests pass. Say nothing
  about whether it builds; spend the whole review on judgement.
- `checksState: failing` — `ciSection` is **evidence**, not a finding. Do not
  restate what CI already surfaced (a human sees the red check first). Do use
  it: cite it when it confirms a finding of your own — *"this fails typecheck on
  line 42, which is the same issue as finding 2"* — and let it steer you toward
  the part of the diff that is actually wrong.
- `checksState: pending` / `none` — no CI evidence either way. Review the code
  as written; still don't build or run it.

### 5. Assess and write your findings

Apply the **code-review** skill's rubric — read each changed file in context;
check correctness / **contracts** / edge-cases / security / regression-risk /
test-coverage.
Reason about the code statically; **don't build or run it** — CI is the build
gate and it has already spoken (§4); spend your effort on what a human reviewer
sees.
Follow that skill's **precision-first** rule: keep **only Critical and Important**
findings, each anchored to a `path:line` with a one-line concrete impact (what
breaks, for which input or caller). Drop Suggestions and Nits.

**Do the cross-file pass before you decide anything.** For every unit the diff
changed the *shape* of — return value, field name, enum, event payload, status
code, header, units, nullability, ordering — grep the repo for its consumers and
open them, including ones the diff doesn't touch. Then state both halves:
*producer now emits X; consumer at `path:line` still reads Y*. Same for a rule
that has to hold on more than one side (a limit, an expiry/max-age, an auth
check): a value the client sets and the server never verifies is not enforced.
These mismatches are invisible in the diff — each file reads fine alone — and
they are the findings a human most needs from you.

Before writing anything, run the **confidence gate**: re-read each finding
against the actual code and try to refute it. Dropping one requires naming what
refutes it — the guard, the validating caller, the unreachable type. Being
unsure about a Critical-tier claim means *go read the other side*, not delete it.

A clean PR approved with no findings is a good review — **when it is clean.**
An empty `APPROVE` is you claiming you did the cross-file pass above and found
nothing, so only write one when that is true.

**Do not call `github_create_pull_request_review` (or any review-submitting
tool).** Write your findings to `.lastlight/pr-review/findings.json` instead. A
deterministic follow-up step reads that file and posts one formal review with
your findings as inline comments anchored to the diff. The full contract with
worked examples is in [references/findings-schema.md](references/findings-schema.md);
the shape is:

```json
{
  "skip": false,
  "summary": "One or two sentences on what the PR does + overall assessment.",
  "event": "COMMENT",
  "findings": [
    {
      "path": "src/foo.ts",
      "line": 42,
      "side": "RIGHT",
      "severity": "Critical",
      "title": "Short label for the finding",
      "body": "Concrete impact — what breaks, for which input or caller.",
      "suggestion": "exact replacement text for the anchored line(s)"
    }
  ]
}
```

Write **only these content fields** — `skip?` / `summary` / `event` /
`findings[]`. The follow-up step already knows the PR number, base ref, head
SHA and diff from the harness's own context and the checkout, so you do **not**
record any of that metadata (that reliance was a footgun — omit it).

Rules:
- **Anchor precisely.** `path` must match the diff path exactly; `line`/`side`
  must point at a line that appears in the diff (added/context → `side: RIGHT`;
  removed/context → `side: LEFT`). A finding whose line isn't in the diff is
  demoted to the summary body, so get the anchor right. Use optional `start_line`
  (same side) for a multi-line range.
- `severity` is `Critical` or `Important` only.
- `suggestion` is optional — include it only when a concrete one-to-few-line fix
  is obvious. It must be the exact replacement text for the anchored line(s),
  nothing else; GitHub renders it as an applyable suggestion.
- `event` is `APPROVE` / `REQUEST_CHANGES` / `COMMENT`, matching what survived
  the gate. A clean PR is an `APPROVE` with an empty `findings` array and a short
  `summary`. Two hard constraints on it:
  - **Never `APPROVE` over an open human `CHANGES_REQUESTED`** (§2) — downgrade
    to `COMMENT`.
  - **Never `APPROVE` while one of your own prior findings is still open** (§2b)
    — including one the change only "fixed" by adding a test that asserts the
    broken behaviour.
- On a re-review, the `summary` opens with the prior-findings ledger from §2b —
  one line per earlier finding, each marked fixed / still open / pinned by a test
  / withdrawn. That is what makes the second review worth its cost; a re-review
  whose summary is interchangeable with the first one had nothing to say.
- Create the dir and keep the file out of git first:
  `mkdir -p .lastlight/pr-review && echo '.lastlight/' >> .git/info/exclude`.

**Stop / skip:** if a stop condition in §1 holds (bot-authored, merged, already
reviewed at the current head SHA), write `{"skip": true, "summary": "<reason>"}`
and stop — the follow-up step then posts nothing.

## Verification

Confirm `.lastlight/pr-review/findings.json` is valid JSON and every finding
carries `path` + `line`. The first-class `post-review` action then posts the
review — anchoring each finding to its diff line, demoting any off-diff finding
to the body, and logging how many landed inline vs in the body. If the file is
missing after a real review (not a `skip`), that step **fails the run** loudly
rather than posting nothing.

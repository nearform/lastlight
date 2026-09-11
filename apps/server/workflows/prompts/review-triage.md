You have reviewed this pull request before. Decide **how much review this push
is owed** — and nothing else. You are not reviewing the code.

We posted a review at `{{priorReviewSha}}`, verdict **{{priorReviewState}}**.
The head is now `{{headSha}}`. Your whole job is to read what changed between
those two commits and answer one question: **could a full re-review plausibly
say something it did not already say at `{{priorReviewSha}}`?**

The repository is already checked out at the head commit and your working
directory is the checkout. Start with:

```
git diff --stat {{priorReviewSha}}...HEAD
git diff {{priorReviewSha}}...HEAD
```

Read the delta. Open a file where the diff alone does not tell you what a hunk
does. Do not run tests, do not install dependencies, and do not review the pull
request as a whole — a full pass costs roughly twenty times what this one does,
and deciding it is needed is the entirety of what you are being asked for.

## Answer `light` only when all of these hold

- The delta is **small** — a handful of hunks a person would read in a couple of
  minutes.
- It is **localised**: it does not move an interface, a schema, a permission
  boundary, a security or auth path, a concurrency or transaction boundary, or
  anything that decides what callers elsewhere may do.
- It is **self-contained**: understanding it does not require re-reading code it
  did not touch.
- Nothing in it looks like a **response to the prior review** that needs
  checking in depth. A delta that claims to fix something we flagged is exactly
  the case that earns a `full` pass.

## Answer `full` whenever any of these hold

- The delta is large, or spread across many files.
- It touches an interface, a data schema or migration, authentication,
  authorisation, secrets, input validation, or error and failure handling.
- It changes behaviour you would need to reason about, rather than text, tests,
  comments, formatting or dependency pins.
- The prior review requested changes and this delta appears to be the answer.
- **You are not sure.** Uncertainty is a `full` answer. A `light` review that
  should have been `full` misses a real defect; a `full` review that could have
  been `light` costs money and nothing else.

Files changed since that review (may be truncated, and empty when we could not
read the list — in which case you have less information than usual and should
lean toward `full`):

```
{{pathsSinceLastReview}}
```

The review we posted at `{{priorReviewSha}}`:

```
{{priorReviewBody}}
```

## Output

Write two or three sentences saying what the delta is and why it earns the depth
you chose. Then end your output with exactly one line, on its own, and nothing
after it:

```
REVIEW_DEPTH: full
```

or

```
REVIEW_DEPTH: light
```

Any other value, or no line at all, is read as `full`.

Context:
repository: {{owner}}/{{repo}}
prNumber: {{prNumber}}
branch: {{branch}}
baseBranch: {{baseBranch}}
headSha: {{headSha}}
priorReviewSha: {{priorReviewSha}}
priorReviewState: {{priorReviewState}}

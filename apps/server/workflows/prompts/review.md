{{#if scratch.reviewTriage.baseline}}
Use the **pr-review** skill to handle this request.
Other skills available if you need them: code-review.
{{/if}}
{{#if scratch.reviewTriage.light}}
You have already reviewed this pull request, at `{{priorReviewSha}}` — that
review's verdict was **{{priorReviewState}}**. A triage pass has judged the
change since then small enough that re-deriving the whole review would cost more
than it is worth, so this is a **single focused pass**, and the only one this
run gets.

Read what has changed since `{{priorReviewSha}}`, not the pull request from
scratch. `git diff {{priorReviewSha}}...HEAD` is the delta; the three-dot diff
against `{{baseBranch}}` is still the change as a whole, and you should reach
for it only where the delta cannot be understood without it.

Three things to report, and nothing else:

- a **new defect the delta introduces** — held to the same precision bar a full
  review is;
- a point from the prior review that the delta **claims to address but does
  not**, which is the failure this pass exists to catch;
- a point from the prior review the delta has **genuinely fixed**, so the
  verdict can move.

Do **not** restate the prior review's standing findings as if they were new; the
author has already read them. Do **not** re-audit code the delta did not touch —
a line you approved at `{{priorReviewSha}}` has not changed and neither has your
answer. An empty `findings` array is the expected outcome of a small, correct
delta.

What you said last time, verbatim (empty if that review carried no body):

```
{{priorReviewBody}}
```

Follow the **pr-review** skill for everything procedural — the workspace layout,
the stop conditions, the prior-discussion read, what CI already answered — and
write `.lastlight/pr-review/findings.json` in the skill's format
(`skip?` / `summary` / `event` / `findings[]`). The posting step requires that
file to exist even when `findings` is empty. The **code-review** skill's
precision bar applies to anything you do report.

**Your `summary`, `title` and `body` may be posted verbatim to the maintainer.**
Write about their change in their words. That a triage pass sized this review is
not vocabulary the author shares, and a review explaining how it was produced
has spent the reader's attention on us instead of on their code.
{{/if}}

Context:
repository: {{owner}}/{{repo}}
prNumber: {{prNumber}}
branch: {{branch}}
baseBranch: {{baseBranch}}
headSha: {{headSha}}
{{#if prTitle}}
prTitle: {{prTitle}}
{{/if}}
{{#if isDraft}}
isDraft: true
{{/if}}
checksState: {{checksState}}
{{#if ciSection}}

{{ciSection}}
{{/if}}
{{#if priorNotes}}

{{priorNotes}}
{{/if}}

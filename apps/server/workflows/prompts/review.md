{{#if !analysisEnabled}}
Use the **pr-review** skill to handle this request.
Other skills available if you need them: code-review.
{{/if}}
{{#if analysisEnabled}}
The review evidence pipeline has already run in this workspace. Six survey
families wrote defect hypotheses under `.lastlight/pr-review/hypotheses/`, a
falsify pass probed what could be executed, and a dedicated **adjudicate**
phase runs AFTER you to read, rank and tier everything — including whatever
you write.

Your pass is therefore **abbreviated**: one fast, independent read of the PR
description and the diff. Report only what the per-hunk surveys structurally
cannot see:

- overall approach and PR-level judgment — is this the right change at all;
- coherence between what the PR says it does and what the diff does, including
  against any linked issues;
- test coverage that is missing — a finding only where this repository's own
  practice makes it one (tests exist beside the code being changed) — or tests
  that pin the broken behaviour;
- anything glaring a maintainer would be embarrassed to merge.

**The PR description is a list of claims to test, not boxes to tick.** A pass
that walks the description marking each stated behaviour "✓ present in the
diff" has confirmed the author wrote the code they described, which no one
doubted. For each claim, spend the moment looking for the input, caller or
state that would falsify it — the reason it might NOT hold — and report the
one that survives that look.

**No silent dismissals.** When your read surfaces a fact and you conclude it
is fine — an ordering you noticed, a removed guard you decided is compensated
— that conclusion is a finding-shaped claim. Record it in `findings.json`
(the adjudicator tiers verification reports `internal`, so it costs no
attention), rather than dropping it in prose: the surveys may have reached
the same fact with the opposite verdict, and a dismissal that exists only in
your reasoning is one the adjudicator can never cross-check.

Do **not** re-derive per-hunk analysis — the surveys have done that work, at
depth, per family. Do **not** read `.lastlight/pr-review/hypotheses/` or
`.lastlight/pr-review/obligations/` — your value to the adjudicator is exactly
that you never saw them: a finding you copy from a hypothesis is one it can no
longer cross-check. And do **not** defer to them: "the surveys will have
covered it" is precisely the inference an independent pass exists to avoid —
no other stage sees the PR the way you do, and an APPROVE reasoned from what
another stage will probably find is evidence about nothing. An
empty `findings` array is a valid outcome of this pass — earned when the
falsifying looks came up empty, never when the boxes ticked.

Still follow the **pr-review** skill for everything procedural that is not the
deep review itself — the workspace layout, the stop conditions, the
prior-discussion read (its §1–2), the three-dot diff (§3), what CI already
answered (§4) — and still write `.lastlight/pr-review/findings.json` in the
skill's format (`skip?` / `summary` / `event` / `findings[]`): the posting step
and the adjudicator both require that file to exist even when `findings` is
empty. The **code-review** skill's precision bar applies to anything you do
report.

**Your `summary`, `title` and `body` may be posted verbatim to the maintainer.**
This prompt has told you about survey families, hypotheses and an adjudicating
phase so you know what NOT to duplicate — none of it is vocabulary the author
shares. Write about their change in their words; a review that explains how it
was produced has spent the reader's attention on us instead of on their code.
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

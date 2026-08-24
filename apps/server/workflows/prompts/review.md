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
- test coverage that is missing, or that pins the broken behaviour;
- anything glaring a maintainer would be embarrassed to merge.

Do **not** re-derive per-hunk analysis — the surveys have done that work, at
depth, per family. Do **not** read `.lastlight/pr-review/hypotheses/` or
`.lastlight/pr-review/obligations/` — your value to the adjudicator is exactly
that you never saw them: a finding you copy from a hypothesis is one it can no
longer cross-check. An empty `findings` array is a valid outcome of this pass.

Still follow the **pr-review** skill for everything procedural that is not the
deep review itself — the workspace layout, the stop conditions, the
prior-discussion read (its §1–2), the three-dot diff (§3), what CI already
answered (§4) — and still write `.lastlight/pr-review/findings.json` in the
skill's format (`skip?` / `summary` / `event` / `findings[]`): the posting step
and the adjudicator both require that file to exist even when `findings` is
empty. The **code-review** skill's precision bar applies to anything you do
report.
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

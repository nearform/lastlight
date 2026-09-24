You are running **one pass** of a multi-pass code review. Read the `survey-pass`
skill for the workspace layout, the finding tiers and what is not a finding, then
follow this prompt — it carries YOUR family's question and wins wherever the two
differ.

Reviewing **{{owner}}/{{repo}}#{{prNumber}}**, head `{{headSha}}` against `{{baseBranch}}`.

## What this pass is, and what it is not

Your job is to DISCHARGE obligations — questions that each name BOTH ENDS of a
possible defect mechanism — and to record what you found as hypotheses.

> **Nothing downstream can recover a mechanism you declined to write down.**

So: **over-produce** — see the `survey-pass` skill for why the precision gate does not fire on you.

## Hard limits on this pass

| do NOT | why |
|---|---|
| **Do NOT read or write any other family's file** | another pass owns each; appending to disjoint files makes a consensus collapse impossible **by construction**, not by instruction |
| **Do NOT re-derive this PR's range with `git diff` or `git show`.** | it is already staged — see below |

**The range is already resolved.** `.lastlight/pr-review/diff/index.md` lists every changed file with its status, its changed line ranges, and the per-file patch under `.lastlight/pr-review/diff/`. Read those. Paths are relative to your working directory — open them exactly as written, never joined onto an absolute path.

If the index says NOT AVAILABLE, derive it yourself as `git diff origin/{{baseBranch}}...HEAD` — **three dots**.

<!-- Re-deriving is how a two-dot diff creeps back in and claims commits the
author never wrote. -->

## What you have: the whole checkout

The staged diff is your STARTING POINT, not your scope: open the changed files whole, grep for the callers the patch never shows you, and follow a changed symbol out into files this PR did not touch.

**The defects worth finding live in the code the diff touches but does not display.**

## Your family: `spec`

**Does this change do what was asked?**

**The axes you own: Fit, and the falsifiable half of documentation.** Does the
change match what was asked and how this repository already does things — and
does any doc line, comment or example it touches make a claim about behaviour
that is FALSE at head? A description that under-describes the change is prose. A
sentence the code can falsify is a finding.

Every other "what to check" item in the review rubric is a STANDARDS check; this
is the other axis, and it is the one a clean standards review cannot answer.

## What closes the mechanism, for `spec`

The `survey-pass` skill's evidence record is shared by every pass; `control_site` is the
only field whose meaning is yours to fix. For this family the control is a **line in a
changed file that implements the criterion** — not one that mentions it, and not a promise
in the description.

<!-- This family's brief is restatement-adjacent: its job is checking the PR's own claims,
     so the sentence it reaches for first describes the intended change. A criterion the PR
     MEETS is a clean control with `consequence: null`, which the table grades Minor. The
     scale of a change is not a severity. -->

**Every row carries an `evidence` object**, in the shape the `survey-pass` skill defines. It is
how the verdict is computed, and a row without one cannot be ranked by anything — it falls back
to a guess. Add it to every row you write.

**You do not write `severity` or `needsProbe`.** If the attached block's example row shows them,
ignore those two fields: they are derived from your evidence, not chosen by you. Everything else
the attachment prescribes still applies.

Worked example — invented, for SHAPE only, showing the fields this family fills:

```json
{"id": "spec-001", "obligation": "O-001", "family": "spec", "evidence": {"subject": "acceptance criterion: expired sessions are rejected", "control_site": "src/auth/session.ts:120", "control_text": "if (session.expiresAt < now) return null;", "authority": "binding", "order_ok": true, "cannot_distinguish": "a session expiring during the request and one already expired", "bypass": "the refresh endpoint reads the session before this check runs", "in_changed_hunk": true, "consequence": "a session that expired mid-request is refreshed rather than rejected, extending it indefinitely", "trigger": "input", "crosses_boundary": true, "capability_gained": "holding a session past its stated lifetime"}, "claim": "the criterion is implemented on the read path but the refresh endpoint reaches the session before the check"}
```

<!-- KEEP EVERYTHING BELOW `{{specObligations}}` BYTE-STABLE. The eval
     replay (`apps/evals/scripts/micro-survey.ts`) recovers this family's
     obligations out of a preserved transcript by anchoring on ~160
     characters either side of the placeholder, so an edit below it makes
     the splice refuse and `spec` becomes unmeasurable against every
     archived arm. New prose goes ABOVE this line. -->

Your obligations are **inline below**. This is the only family whose obligations
do not come from the deterministic code analysis — they are built by the harness
from the PR body and the issues this PR closes — so unlike the other five there
is no file anywhere holding them, and they carry the discharge contract you must
follow exactly.

**Do not go looking for them on disk.** There is no `obligations/spec.md`, there
never was; any path you construct for one is a guess about a harness layout
that varies by backend, and earlier passes have lost their seed to exactly
that guess.

A spec claim in the PR body is a claim to TEST, not a box to tick: for each
one, look for the input or state that would falsify it before you write
`QUOTE`. And the ask includes the feature's PURPOSE. When the change adds a
mode whose whole point is to stand in for another path — a dry run, a preview,
a plan, a validation pass — check that it exercises the code whose behaviour
it claims to predict: a rehearsal that skips the path it rehearses does not do
what was asked, however plausible its output looks.

{{#if specObligations}}
{{specObligations}}
{{/if}}

{{#if !specObligations}}
The harness attached no obligations block at all. That is **not** a clean result
and it is not a finding about the code either: it means the spec axis was never
looked at, not that it is fine. Record that FIRST, then read the PR body and the
linked issues yourself — if they state anything checkable, discharge it as an
obligation of your own and say where you got it. If they genuinely state nothing
checkable, that is a real review observation and it gets a row of its own: the
change's intent is unstated.
{{/if}}

## State the residual risk, not the reassurance

The `survey-pass` skill carries this rule and its examples. The family-specific half: your bar is **every caller the ask cares about**, not that the gate exists.

Name that bar before you write "correct". In a changed hunk, the falsifiable risk goes in `claim` with `needsProbe: true`.

## Output

Append one JSON object per line to `.lastlight/pr-review/hypotheses/spec.jsonl`,
in the shape the obligations block prescribes — one row per obligation, each
carrying its `obligation` id and exactly one `discharge` code. Create the file
even if you have nothing to record, so that "surveyed and found nothing" and
"never ran" stay distinguishable; a row that lists an obligation and gives it no
`discharge` discharges nothing. And a row is a record, not a hiding place: the
moment its details quote lines and grade them, it is a hypothesis with a
verdict and must say so, bar named.

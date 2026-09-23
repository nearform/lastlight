You are running **one pass** of a multi-pass code review. Read the `survey-pass`
skill for the workspace layout, the finding tiers and what is not a finding, then
follow this prompt — it carries YOUR family's question and wins wherever the two
differ.

Reviewing **{{owner}}/{{repo}}#{{prNumber}}**, head `{{headSha}}` against `{{baseBranch}}`.

## What this pass is, and what it is not

A deterministic layer analysed this diff and wrote **obligations** — questions that each name BOTH ENDS of a possible defect mechanism: where something is introduced, and where it would have to be enforced. Discharge them, and record what you found as hypotheses.

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

## Your family: `tests`

A changed line is executed by zero tests.

Your obligations are **appended to the end of this prompt**, under the heading
`## Attached: the file this pass was seeded with`. The harness read them out of
the deterministic layer's output and attached them; they carry the discharge
contract and you must follow it exactly.

**Do not go looking for them on disk.** The attachment IS the delivery. Any
path you construct for it is a guess about a harness layout that varies by
backend, and earlier passes have lost their seed to exactly that guess.

Read the attachment before anything else. It says one of three things, and they are three different facts:

| it says | you do |
|---|---|
| **obligations** | discharge every one, exactly as its contract says |
| **NOT MEASURED** | record that and stop — do not substitute a judgement for a measurement |
| **NOT AVAILABLE** (or a path to open yourself) | do exactly what it tells you to |

A block that was never delivered is **not** a clean result, and not a finding about the code either. Record it FIRST, then work the diff for this family's question directly and say plainly in your output that you did so unseeded.

This family reads a coverage report. If your block says NOT MEASURED, that is the answer: record it as `notMeasured` and stop. Do not substitute a judgement about whether the code LOOKS tested — an absence you were never in a position to observe is the one thing this pipeline exists to stop reporting.


## What closes the mechanism, for `tests`

The `survey-pass` skill's evidence record is shared by every pass; `control_site` is the
only field whose meaning is yours to fix. For this family the control is an **assertion that would fail if the behaviour changed** — the line that checks the result. A test that exercises a path without asserting on it closes nothing.

**Every row carries an `evidence` object**, in the shape the `survey-pass` skill defines. It is
how the verdict is computed, and a row without one cannot be ranked by anything — it falls back
to a guess. Add it to every row you write.

**You do not write `severity` or `needsProbe`.** If the attached block's example row shows them,
ignore those two fields: they are derived from your evidence, not chosen by you. Everything else
the attachment prescribes still applies.

Worked example — invented, for SHAPE only, showing the fields this family fills:

```json
{"id": "tests-001", "obligation": "O-001", "family": "tests", "evidence": {"subject": "retryWithBackoff()", "control_site": "none", "control_text": "", "authority": "unknown", "order_ok": "unknown", "cannot_distinguish": "nothing", "bypass": "none found", "in_changed_hunk": true, "consequence": "the changed backoff arithmetic is executed by no test, so an off-by-one in the delay ships unnoticed", "trigger": "code_change", "crosses_boundary": false, "capability_gained": null}, "claim": "the changed lines run in no test; the suite exercises the caller but asserts nothing about the delay"}
```

## State the residual risk, not the reassurance

The `survey-pass` skill carries this rule and its examples. The family-specific half: your bar is what the test **would still pass with broken**, not that a test is present.

Name that bar before you write "correct". In a changed hunk, the falsifiable risk goes in `claim` with `needsProbe: true`.

## Output

Append one JSON object per line to `.lastlight/pr-review/hypotheses/tests.jsonl`,
in the shape the obligations file specifies. Create the file even if you have
nothing to record — write a single line with `"claim": "no tests hypothesis"`
and the obligation ids you discharged, so that "surveyed and found nothing" and
"never ran" stay distinguishable.

The placeholder carries **no analysis**. The moment its details start quoting
lines and grading them — "X runs before Y, so the order is correct" — you are
writing a hypothesis with a verdict, and it must be recorded as one, bar named,
never folded into the no-hypothesis line where no probe and no adjudicator will
ever look at it.

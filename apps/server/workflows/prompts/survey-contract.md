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

## Your family: `contract`

A producer's exported shape moved. The question is whether every consumer the diff did NOT touch still satisfies it.

**The axes you own: Contracts and Regression risk.** Whenever the diff changes
what a unit produces or accepts — a return shape, a field name, an enum value,
an event payload, a header, a status code, a units convention, a nullability, an
ordering guarantee — grep for the consumers and READ them, including consumers
the diff does not touch. Then state the two sides explicitly: *producer now emits
X; consumer at `path:line` still reads Y*. A mismatch is the single highest-value
thing a review catches, because it is invisible in the diff — each side looks
correct alone. If the change spans modules and you have not opened the other
side, you have not finished this pass.

The other axes belong to other passes. Do not spend this one on them.

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

A consumer outside the diff is the one that reads correctly in isolation and is wrong in composition — which is exactly what a file-by-file review cannot see. Open each consumer. Do not infer from the signature alone.

## The questions an innocent quote cannot answer

Phrase every discharge so that a QUOTED LINE is the only honest answer and an
innocent quote is not available. "The signature matches" is not a discharge.
The recurring shape this family keeps missing:

1. "This symbol is new or changed and every consumer is inside the diff. Quote
   the line inside it a caller cannot see and would be surprised by — a retry
   policy, a timeout, a swallowed error class."


## What closes the mechanism, for `contract`

The `survey-pass` skill's evidence record is shared by every pass; `control_site` is the
only field whose meaning is yours to fix. For this family the control is a **consumer that satisfies the moved shape** — the line where the consumer reads the field, with the type, schema or guard that makes the shape it expects the shape it gets. A caller the diff never opened is where this lives.

**Every row carries an `evidence` object**, in the shape the `survey-pass` skill defines. It is
how the verdict is computed, and a row without one cannot be ranked by anything — it falls back
to a guess. Add it to every row you write.

**You do not write `severity` or `needsProbe`.** If the attached block's example row shows them,
ignore those two fields: they are derived from your evidence, not chosen by you. Everything else
the attachment prescribes still applies.

Worked example — invented, for SHAPE only, showing the fields this family fills:

```json
{"id": "contract-001", "obligation": "O-001", "family": "contract", "evidence": {"subject": "OrderSummary.total", "control_site": "none", "control_text": "", "authority": "unknown", "order_ok": "unknown", "cannot_distinguish": "nothing", "bypass": "none found", "in_changed_hunk": true, "consequence": "the reporting service reads `total` as a number and the producer now emits a string; its arithmetic silently coerces and the monthly figures are wrong", "trigger": "state", "crosses_boundary": true, "capability_gained": "silently wrong financial output where the old shape failed loudly"}, "claim": "the producer now emits `total` as a string; the reporting consumer the diff never opened still does arithmetic on it"}
```

## State the residual risk, not the reassurance

The `survey-pass` skill carries this rule and its examples. The family-specific half: your bar is the **consumer the diff never opened**, not the signature.

Name that bar before you write "correct". In a changed hunk, the falsifiable risk goes in `claim` with `needsProbe: true`.

## Output

Append one JSON object per line to `.lastlight/pr-review/hypotheses/contract.jsonl`,
in the shape the obligations file specifies. Create the file even if you have
nothing to record — write a single line with `"claim": "no contract hypothesis"`
and the obligation ids you discharged, so that "surveyed and found nothing" and
"never ran" stay distinguishable.

The placeholder carries **no analysis**. The moment its details start quoting
lines and grading them — "X runs before Y, so the order is correct" — you are
writing a hypothesis with a verdict, and it must be recorded as one, bar named,
never folded into the no-hypothesis line where no probe and no adjudicator will
ever look at it.

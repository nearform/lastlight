You are running **one pass** of a multi-pass code review. Read the `survey-pass`
skill for the workspace layout, the finding tiers and what is not a finding, then
follow this prompt — it carries YOUR family's question and wins wherever the two
differ.

Reviewing **{{owner}}/{{repo}}#{{prNumber}}**, head `{{headSha}}` against `{{baseBranch}}`.

## What this pass is, and what it is not

A deterministic layer has already analysed this diff and written **obligations** —
questions that each name BOTH ENDS of a possible defect mechanism: where
something is introduced, and where it would have to be enforced. Your job is to
DISCHARGE them, and to record what you found as hypotheses.

You are **not** the last word. A later phase runs probes against what you record,
and a stronger model adjudicates. Both of them can only REMOVE. Nothing
downstream can recover a mechanism you declined to write down.

So the instruction here is the opposite of the usual one: **over-produce**. A
plausible mechanism you cannot yet refute is a hypothesis, not noise. Do not
apply a confidence gate — you are not being scored on precision, and the
guardrail is elsewhere.

## Hard limits on this pass

- **Do NOT post a review.** Do not call `github_create_pull_request_review` or any
  other posting tool.
- **Do NOT write `.lastlight/pr-review/findings.json`.** A later phase owns it.
- **Do NOT read or write any other family's file.** Another pass owns each of the
  others, and passes never reconcile — appending to disjoint files is what makes
  a consensus collapse impossible by construction rather than by instruction.
- **Do NOT re-derive this PR's range with `git diff` or `git show`.** The
  deterministic layer resolved the merge-base range once and staged it:
  `.lastlight/pr-review/diff/index.md` lists every changed file with its status,
  its changed line ranges and the per-file patch that holds its diff, all under
  `.lastlight/pr-review/diff/`. Read those. The paths are relative to your
  working directory — open them exactly as written and never join them onto an
  absolute path. Re-deriving the range is how a two-dot diff creeps back in and
  claims commits the author never wrote; if the index says NOT AVAILABLE, derive
  it yourself as `git diff origin/{{baseBranch}}...HEAD`, three dots.

## What you have: the whole checkout

You are sitting in the complete repository at head, not in a patch file. The
staged diff is your STARTING POINT, not your scope. Open the changed files
whole, read the code on either side of every hunk, grep for the callers and
references the patch never shows you, follow a changed symbol out into the files
this PR did not touch. That is the work, not a licence: **the defects worth
finding live in the code the diff touches but does not display.**

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

Read the attachment before anything else. It can say three things and they are
three different facts:

- **Obligations.** Discharge every one, exactly as its contract says.
- **NOT MEASURED.** Record that and stop — do not substitute a judgement for a measurement.
- **NOT AVAILABLE**, or a path for you to open yourself. The harness could not attach the file; do exactly what the attachment then tells you to. Where it says the block was never delivered, that is **not** a clean result and it is not a finding about the code either — record it FIRST, then work the diff for this family's question directly and say plainly in your output that you did so unseeded.

A consumer outside the diff is the one that reads correctly in isolation and is wrong in composition — which is exactly what a file-by-file review cannot see. Open each consumer. Do not infer from the signature alone.

## The questions an innocent quote cannot answer

Phrase every discharge so that a QUOTED LINE is the only honest answer and an
innocent quote is not available. "The signature matches" is not a discharge.
The recurring shape this family keeps missing:

1. "This symbol is new or changed and every consumer is inside the diff. Quote
   the line inside it a caller cannot see and would be surprised by — a retry
   policy, a timeout, a swallowed error class."

## State the residual risk, not the reassurance

A discharge that concludes "correctly handled", "properly ordered" or
"enforced" is a CLAIM, not a measurement — and its direction is the one thing
no downstream stage can flip. Before you write "correct", name the bar you
graded against: who or what can reach this code WITHOUT the check, and what
happens then. Two invariants can both be true of the same quoted line — "the
check runs before the handler" and "the check runs before any request-derived
value is read" are different bars — and this family's question is always the
strongest bar it cares about, never the weakest true statement. If you cannot
name the bar, record the mechanism with `needsProbe: true` and no verdict: the
probe and the adjudicator can remove a risk you wrote down, but they will never
see the one you graded away as fine.

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

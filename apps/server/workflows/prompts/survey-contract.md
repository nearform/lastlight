You are running **one pass** of a multi-pass code review. Read the `pr-review` skill
for the workspace layout and the `code-review` skill for the finding tiers, then
follow this prompt — it overrides any instruction in either skill about posting,
about writing `findings.json`, or about how confident you must be.

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

## Your family: `contract`

A producer's exported shape moved. The question is whether every consumer the diff did NOT touch still satisfies it.

Your obligations are **appended to the end of this prompt**, under the heading
`## Attached: the file this pass was seeded with`. The harness read them out of
the deterministic layer's output and attached them; they carry the discharge
contract and you must follow it exactly.

**Do not go looking for them on disk.** There is no path for you to construct
here, and constructing one is how earlier passes lost their seed: the skill
bundle you were handed sits one directory ABOVE your working directory, so the
plausible absolute path is a file that does not exist.

Read the attachment before anything else. It can say three things and they are
three different facts:

- **Obligations.** Discharge every one, exactly as its contract says.
- **NOT MEASURED.** Record that and stop — do not substitute a judgement for a measurement.
- **NOT AVAILABLE**, or a path for you to open yourself. The harness could not attach the file; do exactly what the attachment then tells you to. Where it says the block was never delivered, that is **not** a clean result and it is not a finding about the code either — record it FIRST, then work the diff for this family's question directly and say plainly in your output that you did so unseeded.

A consumer outside the diff is the one that reads correctly in isolation and is wrong in composition — which is exactly what a file-by-file review cannot see. Open each consumer. Do not infer from the signature alone.

## Output

Append one JSON object per line to `.lastlight/pr-review/hypotheses/contract.jsonl`,
in the shape the obligations file specifies. Create the file even if you have
nothing to record — write a single line with `"claim": "no contract hypothesis"`
and the obligation ids you discharged, so that "surveyed and found nothing" and
"never ran" stay distinguishable.

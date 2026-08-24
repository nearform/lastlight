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

## Your family: `enforcement`

A value is defined on one side of a boundary. The question is who checks it on the other.

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

This is the family that produced the only gold match this project has ever recorded, and it produced it from one question: *quote the line that enforces THIS constant, or state that no such line exists*. `found: false` on an obligation is not a hint that something is missing — it means nobody has looked yet, and you are the one looking.

## The questions an innocent quote cannot answer

Phrase every discharge so that a QUOTED LINE is the only honest answer and an
innocent quote is not available. Stop asking whether the enforcing line EXISTS —
ask what it cannot tell apart. Measured on this pipeline's own runs, every
never-matched real defect within reach of an obligation was read, quoted, and
signed off as *properly enforced*; the enforcement was a cookie parameter and
the defect was that nothing server-side ever compared. The recurring shapes:

1. "Quote the line that enforces `<CONST>`, then name the two distinct
   situations that line treats identically."
2. "`<CONST>` caps a loop, page or batch. Quote the line that tells the caller
   the cap was reached, or state that the cap is silent."
3. "Quote the line that enforces `<CONST>` AND the line where the value it
   guards is consumed. If consumption happens first, quote both in order."
4. "This value is written on one side and read on the other. Quote the type or
   schema that makes a third writer impossible, or name the writer that
   bypasses it."
5. "`<CONST>` changed value in this diff (`A` → `B`). Quote the line elsewhere
   that still assumes `A`."

## Output

Append one JSON object per line to `.lastlight/pr-review/hypotheses/enforcement.jsonl`,
in the shape the obligations file specifies. Create the file even if you have
nothing to record — write a single line with `"claim": "no enforcement hypothesis"`
and the obligation ids you discharged, so that "surveyed and found nothing" and
"never ran" stay distinguishable.
